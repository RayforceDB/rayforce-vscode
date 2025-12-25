/**
 * Rayforce IPC Client for TypeScript
 * Native implementation of Rayforce protocol without external executable
 */

import * as net from 'net';

// ============================================================================
// Constants
// ============================================================================

const RAYFORCE_VERSION = 1;
const SERDE_PREFIX = 0xcefadefa;

// Message types
const MSG_TYPE_ASYNC = 0;
const MSG_TYPE_SYNC = 1;
const MSG_TYPE_RESP = 2;

// Data types
const TYPE_LIST = 0;
const TYPE_B8 = 1;
const TYPE_U8 = 2;
const TYPE_I16 = 3;
const TYPE_I32 = 4;
const TYPE_I64 = 5;
const TYPE_SYMBOL = 6;
const TYPE_DATE = 7;
const TYPE_TIME = 8;
const TYPE_TIMESTAMP = 9;
const TYPE_F64 = 10;
const TYPE_GUID = 11;
const TYPE_C8 = 12;
const TYPE_TABLE = 98;
const TYPE_DICT = 99;
const TYPE_LAMBDA = 100;
const TYPE_NULL = 126;
const TYPE_ERR = 127;

// Error codes
const ERR_INIT = 1;
const ERR_PARSE = 2;
const ERR_EVAL = 3;
const ERR_FORMAT = 4;
const ERR_TYPE = 5;
const ERR_LENGTH = 6;
const ERR_ARITY = 7;
const ERR_INDEX = 8;
const ERR_HEAP = 9;
const ERR_IO = 10;
const ERR_SYS = 11;
const ERR_OS = 12;
const ERR_NOT_FOUND = 13;
const ERR_NOT_EXIST = 14;
const ERR_NOT_IMPLEMENTED = 15;
const ERR_NOT_SUPPORTED = 16;

// ============================================================================
// Types
// ============================================================================

export interface RayforceDate {
    _type: 'date';
    value: number; // i32: days since 2000-01-01
}

export interface RayforceTime {
    _type: 'time';
    value: number; // i32: milliseconds since midnight
}

export interface RayforceTimestamp {
    _type: 'timestamp';
    value: bigint; // i64: nanoseconds since 2000-01-01
}

export type RayforceValue = 
    | null
    | boolean
    | number
    | bigint
    | string
    | symbol
    | RayforceDate
    | RayforceTime
    | RayforceTimestamp
    | RayforceValue[]
    | RayforceTable
    | RayforceDict
    | RayforceError;

export interface RayforceTable {
    _type: 'table';
    columns: string[];
    columnTypes: string[];  // Rayforce type names for each column
    values: RayforceValue[][];
}

export interface RayforceDict {
    _type: 'dict';
    keys: RayforceValue;
    values: RayforceValue;
}

export interface RayforceError {
    _type: 'error';
    code: number;
    message: string;
}

export interface IpcHeader {
    prefix: number;
    version: number;
    flags: number;
    endian: number;
    msgtype: number;
    size: bigint;
}

// ============================================================================
// Serialization
// ============================================================================

class Serializer {
    /**
     * Serialize a string value to Rayforce format
     */
    static serializeString(str: string): Buffer {
        const strBytes = Buffer.from(str, 'utf8');
        const len = strBytes.length;
        
        // type (1) + attrs (1) + length (8) + data
        const buf = Buffer.alloc(1 + 1 + 8 + len);
        let offset = 0;
        
        buf.writeInt8(TYPE_C8, offset); offset += 1;
        buf.writeUInt8(0, offset); offset += 1; // attrs
        buf.writeBigInt64LE(BigInt(len), offset); offset += 8;
        strBytes.copy(buf, offset);
        
        return buf;
    }

    /**
     * Create IPC message with header
     */
    static createMessage(payload: Buffer, msgtype: number): Buffer {
        const headerSize = 16;
        const msg = Buffer.alloc(headerSize + payload.length);
        let offset = 0;
        
        // Header
        msg.writeUInt32LE(SERDE_PREFIX, offset); offset += 4;
        msg.writeUInt8(RAYFORCE_VERSION, offset); offset += 1;
        msg.writeUInt8(0, offset); offset += 1; // flags
        msg.writeUInt8(0, offset); offset += 1; // endian (little)
        msg.writeUInt8(msgtype, offset); offset += 1;
        msg.writeBigInt64LE(BigInt(payload.length), offset); offset += 8;
        
        // Payload
        payload.copy(msg, offset);
        
        return msg;
    }
}

// ============================================================================
// Deserialization
// ============================================================================

// Rayforce epoch constants (from temporal.h)
const RAYFORCE_EPOCH_YEAR = 2000;
const UT_EPOCH_SHIFT_MS = 946684800 * 1000; // milliseconds from Unix epoch (1970-01-01) to Rayforce epoch (2000-01-01)
const MSECS_IN_DAY = 24 * 60 * 60 * 1000;
const NSECS_IN_DAY = 24 * 60 * 60 * 1000000000;

// NULL value constants (from rayforce.h)
const NULL_I32 = -2147483648; // 0x80000000
const NULL_I64 = BigInt('-9223372036854775808'); // 0x8000000000000000LL

/**
 * Convert Rayforce Date (days since 2000-01-01) to RayforceDate or null
 */
function dateFromI32(days: number): RayforceDate | null {
    if (days === NULL_I32) {
        return null;
    }
    return { _type: 'date', value: days };
}

/**
 * Convert Rayforce Time (milliseconds since midnight) to RayforceTime or null
 */
function timeFromI32(milliseconds: number): RayforceTime | null {
    if (milliseconds === NULL_I32) {
        return null;
    }
    return { _type: 'time', value: milliseconds };
}

/**
 * Convert Rayforce Timestamp (nanoseconds since 2000-01-01) to RayforceTimestamp or null
 */
function timestampFromI64(nanoseconds: bigint): RayforceTimestamp | null {
    if (nanoseconds === NULL_I64) {
        return null;
    }
    return { _type: 'timestamp', value: nanoseconds };
}

class Deserializer {
    private buf: Buffer;
    private offset: number;

    constructor(buf: Buffer) {
        this.buf = buf;
        this.offset = 0;
    }

    get remaining(): number {
        return this.buf.length - this.offset;
    }

    readInt8(): number {
        const val = this.buf.readInt8(this.offset);
        this.offset += 1;
        return val;
    }

    readUInt8(): number {
        const val = this.buf.readUInt8(this.offset);
        this.offset += 1;
        return val;
    }

    readInt16LE(): number {
        const val = this.buf.readInt16LE(this.offset);
        this.offset += 2;
        return val;
    }

    readInt32LE(): number {
        const val = this.buf.readInt32LE(this.offset);
        this.offset += 4;
        return val;
    }

    readBigInt64LE(): bigint {
        const val = this.buf.readBigInt64LE(this.offset);
        this.offset += 8;
        return val;
    }

    readDoubleLE(): number {
        const val = this.buf.readDoubleLE(this.offset);
        this.offset += 8;
        return val;
    }

    readBuffer(len: number): Buffer {
        const val = this.buf.subarray(this.offset, this.offset + len);
        this.offset += len;
        return val;
    }

    readNullTerminatedString(): string {
        let end = this.offset;
        while (end < this.buf.length && this.buf[end] !== 0) {
            end++;
        }
        const str = this.buf.toString('utf8', this.offset, end);
        this.offset = end + 1; // skip null terminator
        return str;
    }

    /**
     * Parse IPC header
     */
    static parseHeader(buf: Buffer): IpcHeader | null {
        if (buf.length < 16) {
            return null;
        }

        return {
            prefix: buf.readUInt32LE(0),
            version: buf.readUInt8(4),
            flags: buf.readUInt8(5),
            endian: buf.readUInt8(6),
            msgtype: buf.readUInt8(7),
            size: buf.readBigInt64LE(8)
        };
    }

    /**
     * Deserialize a value from buffer
     */
    deserialize(): RayforceValue {
        if (this.remaining < 1) {
            return null;
        }

        const type = this.readInt8();

        switch (type) {
            case TYPE_NULL:
                return null;

            // Atoms (negative types)
            case -TYPE_B8:
                return this.readInt8() !== 0;
            
            case -TYPE_U8:
                return this.readUInt8();

            case -TYPE_I16:
                return this.readInt16LE();

            case -TYPE_I32:
                return this.readInt32LE();

            case -TYPE_DATE:
                return dateFromI32(this.readInt32LE());

            case -TYPE_TIME:
                return timeFromI32(this.readInt32LE());

            case -TYPE_I64:
                return this.readBigInt64LE();

            case -TYPE_TIMESTAMP:
                return timestampFromI64(this.readBigInt64LE());

            case -TYPE_F64:
                return this.readDoubleLE();

            case -TYPE_SYMBOL:
                return Symbol.for(this.readNullTerminatedString());

            case -TYPE_C8:
                return String.fromCharCode(this.readInt8());

            case -TYPE_GUID:
                return this.readBuffer(16).toString('hex');

            // Vectors (positive types)
            case TYPE_B8:
            case TYPE_U8:
            case TYPE_C8:
            case TYPE_I32:
            case TYPE_DATE:
            case TYPE_TIME:
            case TYPE_I64:
            case TYPE_TIMESTAMP:
            case TYPE_F64:
            case TYPE_SYMBOL:
            case TYPE_GUID:
            case TYPE_LIST:
                return this.deserializeVector(type);

            case TYPE_TABLE:
                return this.deserializeTable();

            case TYPE_DICT:
                return this.deserializeDict();

            case TYPE_ERR:
                return this.deserializeError();

            default:
                throw new Error(`Unsupported type: ${type}`);
        }
    }

    private deserializeVector(type: number): RayforceValue {
        this.readUInt8(); // skip attrs
        const len = Number(this.readBigInt64LE());

        switch (type) {
            case TYPE_B8:
                return Array.from({ length: len }, () => this.readInt8() !== 0);

            case TYPE_U8:
                return Array.from(this.readBuffer(len));

            case TYPE_C8:
                return this.readBuffer(len).toString('utf8');

            case TYPE_I32:
                return Array.from({ length: len }, () => this.readInt32LE());

            case TYPE_DATE:
                return Array.from({ length: len }, () => dateFromI32(this.readInt32LE()));

            case TYPE_TIME:
                return Array.from({ length: len }, () => timeFromI32(this.readInt32LE()));

            case TYPE_I64:
                return Array.from({ length: len }, () => this.readBigInt64LE());

            case TYPE_TIMESTAMP:
                return Array.from({ length: len }, () => timestampFromI64(this.readBigInt64LE()));

            case TYPE_F64:
                return Array.from({ length: len }, () => this.readDoubleLE());

            case TYPE_SYMBOL:
                return Array.from({ length: len }, () => Symbol.for(this.readNullTerminatedString()));

            case TYPE_GUID:
                return Array.from({ length: len }, () => this.readBuffer(16).toString('hex'));

            case TYPE_LIST:
                return Array.from({ length: len }, () => this.deserialize());

            default:
                throw new Error(`Unsupported vector type: ${type}`);
        }
    }

    private deserializeTable(): RayforceTable {
        this.readUInt8(); // skip attrs
        const keys = this.deserialize();
        
        // Deserialize the column list while capturing types
        const { values: columnValues, types: columnTypes } = this.deserializeTableColumns();

        const columns = Array.isArray(keys) 
            ? keys.map(k => typeof k === 'symbol' ? Symbol.keyFor(k) || String(k) : String(k))
            : [];

        return {
            _type: 'table',
            columns,
            columnTypes,
            values: columnValues
        };
    }

    private deserializeTableColumns(): { values: RayforceValue[][], types: string[] } {
        if (this.remaining < 1) {
            return { values: [], types: [] };
        }

        const listType = this.readInt8();
        if (listType !== TYPE_LIST) {
            // Not a list, fall back to regular deserialization
            // Put the byte back by adjusting offset
            this.offset -= 1;
            const val = this.deserialize();
            return { 
                values: Array.isArray(val) ? val as RayforceValue[][] : [], 
                types: [] 
            };
        }

        this.readUInt8(); // skip attrs
        const len = Number(this.readBigInt64LE());

        const values: RayforceValue[][] = [];
        const types: string[] = [];

        for (let i = 0; i < len; i++) {
            const { value, typeName } = this.deserializeWithType();
            values.push(Array.isArray(value) ? value as RayforceValue[] : [value]);
            types.push(typeName);
        }

        return { values, types };
    }

    private deserializeWithType(): { value: RayforceValue, typeName: string } {
        if (this.remaining < 1) {
            return { value: null, typeName: 'Null' };
        }

        const type = this.readInt8();
        const typeName = this.getTypeName(type);

        switch (type) {
            case TYPE_NULL:
                return { value: null, typeName };
            case -TYPE_B8:
                return { value: this.readInt8() !== 0, typeName };
            case -TYPE_U8:
                return { value: this.readUInt8(), typeName };
            case -TYPE_I16:
                return { value: this.readInt16LE(), typeName };
            case -TYPE_I32:
                return { value: this.readInt32LE(), typeName };
            case -TYPE_DATE:
                return { value: dateFromI32(this.readInt32LE()), typeName };
            case -TYPE_TIME:
                return { value: timeFromI32(this.readInt32LE()), typeName };
            case -TYPE_I64:
                return { value: this.readBigInt64LE(), typeName };
            case -TYPE_TIMESTAMP:
                return { value: timestampFromI64(this.readBigInt64LE()), typeName };
            case -TYPE_F64:
                return { value: this.readDoubleLE(), typeName };
            case -TYPE_SYMBOL:
                return { value: Symbol.for(this.readNullTerminatedString()), typeName };
            case -TYPE_C8:
                return { value: String.fromCharCode(this.readInt8()), typeName };
            case -TYPE_GUID:
                return { value: this.readBuffer(16).toString('hex'), typeName };
            case TYPE_B8:
            case TYPE_U8:
            case TYPE_C8:
            case TYPE_I32:
            case TYPE_DATE:
            case TYPE_TIME:
            case TYPE_I64:
            case TYPE_TIMESTAMP:
            case TYPE_F64:
            case TYPE_SYMBOL:
            case TYPE_GUID:
            case TYPE_LIST:
                const vectorValue = this.deserializeVector(type);
                return { value: vectorValue, typeName };
            case TYPE_TABLE:
                return { value: this.deserializeTable(), typeName };
            case TYPE_DICT:
                return { value: this.deserializeDict(), typeName };
            case TYPE_ERR:
                return { value: this.deserializeError(), typeName };
            default:
                throw new Error(`Unsupported type: ${type}`);
        }
    }

    private getTypeName(type: number): string {
        const typeNames: { [key: number]: string } = {
            [TYPE_NULL]: 'Null',
            [-TYPE_B8]: 'B8', [TYPE_B8]: 'B8',
            [-TYPE_U8]: 'U8', [TYPE_U8]: 'U8',
            [-TYPE_I16]: 'I16',
            [-TYPE_I32]: 'I32', [TYPE_I32]: 'I32',
            [-TYPE_I64]: 'I64', [TYPE_I64]: 'I64',
            [-TYPE_F64]: 'F64', [TYPE_F64]: 'F64',
            [-TYPE_C8]: 'C8', [TYPE_C8]: 'C8',
            [-TYPE_SYMBOL]: 'Symbol', [TYPE_SYMBOL]: 'Symbol',
            [-TYPE_DATE]: 'Date', [TYPE_DATE]: 'Date',
            [-TYPE_TIME]: 'Time', [TYPE_TIME]: 'Time',
            [-TYPE_TIMESTAMP]: 'Timestamp', [TYPE_TIMESTAMP]: 'Timestamp',
            [-TYPE_GUID]: 'GUID', [TYPE_GUID]: 'GUID',
            [TYPE_LIST]: 'List',
            [TYPE_TABLE]: 'Table',
            [TYPE_DICT]: 'Dict',
            [TYPE_ERR]: 'Error',
            [TYPE_LAMBDA]: 'Lambda'
        };
        return typeNames[type] || 'Unknown';
    }

    private deserializeDict(): RayforceDict {
        this.readUInt8(); // skip attrs
        const keys = this.deserialize();
        const values = this.deserialize();

        return {
            _type: 'dict',
            keys,
            values
        };
    }

    private deserializeError(): RayforceError {
        const code = this.readInt8();
        const msg = this.deserialize();
        
        return {
            _type: 'error',
            code,
            message: typeof msg === 'string' ? msg : String(msg)
        };
    }
}

// ============================================================================
// IPC Client
// ============================================================================

export class RayforceIpcClient {
    private socket: net.Socket | null = null;
    private host: string;
    private port: number;
    private connected: boolean = false;
    private responseBuffer: Buffer = Buffer.alloc(0);
    private pendingResolve: ((value: RayforceValue) => void) | null = null;
    private pendingReject: ((reason: Error) => void) | null = null;

    constructor(host: string, port: number) {
        this.host = host;
        this.port = port;
    }

    async connect(timeout: number = 5000): Promise<void> {
        return new Promise((resolve, reject) => {
            let settled = false;
            
            const settle = (fn: () => void) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timeoutHandle);
                    fn();
                }
            };

            const timeoutHandle = setTimeout(() => {
                settle(() => {
                    this.disconnect();
                    reject(new Error(`Connection timeout after ${timeout}ms`));
                });
            }, timeout);

            this.socket = new net.Socket();
            
            this.socket.on('error', (err) => {
                settle(() => {
                    this.connected = false;
                    reject(err);
                });
            });

            this.socket.on('close', () => {
                this.connected = false;
                // If still connecting, reject the connect promise
                settle(() => {
                    reject(new Error('Connection closed'));
                });
                // Also handle pending execute operations
                if (this.pendingReject) {
                    this.pendingReject(new Error('Connection closed'));
                    this.pendingResolve = null;
                    this.pendingReject = null;
                }
            });

            this.socket.connect(this.port, this.host, () => {
                const handshake = Buffer.alloc(2);
                handshake[0] = RAYFORCE_VERSION;
                handshake[1] = 0;
                
                this.socket!.write(handshake, (writeErr) => {
                    if (writeErr) {
                        settle(() => reject(writeErr));
                        return;
                    }
                    
                    this.socket!.once('data', (data: Buffer) => {
                        if (data.length >= 1 && data[0] === RAYFORCE_VERSION) {
                            settle(() => {
                                this.connected = true;
                                this.socket!.on('data', (d) => this.handleData(d));
                                
                                if (data.length > 1) {
                                    this.responseBuffer = Buffer.concat([this.responseBuffer, data.subarray(1)]);
                                    this.tryProcessResponse();
                                }
                                resolve();
                            });
                        } else {
                            settle(() => reject(new Error('Invalid handshake response')));
                        }
                    });
                });
            });
        });
    }

    disconnect(): void {
        // Clear pending operations first
        if (this.pendingReject) {
            this.pendingReject(new Error('Disconnected'));
        }
        this.pendingResolve = null;
        this.pendingReject = null;
        
        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket.destroy();
            this.socket = null;
        }
        this.connected = false;
        this.responseBuffer = Buffer.alloc(0);
    }

    isConnected(): boolean {
        return this.connected && this.socket !== null;
    }

    async execute(statement: string, timeout: number = 30000): Promise<RayforceValue> {
        if (!this.isConnected()) {
            throw new Error('Not connected to Rayforce instance');
        }

        return new Promise((resolve, reject) => {
            const timeoutHandle = setTimeout(() => {
                this.pendingResolve = null;
                this.pendingReject = null;
                reject(new Error(`Execution timeout after ${timeout}ms`));
            }, timeout);

            this.pendingResolve = (value) => {
                clearTimeout(timeoutHandle);
                resolve(value);
            };
            
            this.pendingReject = (err) => {
                clearTimeout(timeoutHandle);
                reject(err);
            };

            const payload = Serializer.serializeString(statement);
            const message = Serializer.createMessage(payload, MSG_TYPE_SYNC);

            this.socket!.write(message, (err) => {
                if (err) {
                    clearTimeout(timeoutHandle);
                    this.pendingResolve = null;
                    this.pendingReject = null;
                    reject(err);
                }
            });
        });
    }

    async executeAsync(statement: string): Promise<void> {
        if (!this.isConnected()) {
            throw new Error('Not connected to Rayforce instance');
        }

        return new Promise((resolve, reject) => {
            const payload = Serializer.serializeString(statement);
            const message = Serializer.createMessage(payload, MSG_TYPE_ASYNC);

            this.socket!.write(message, (err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    private handleData(data: Buffer): void {
        // Ignore data if disconnected
        if (!this.connected || !this.socket) {
            return;
        }
        
        this.responseBuffer = Buffer.concat([this.responseBuffer, data]);
        this.tryProcessResponse();
    }

    private tryProcessResponse(): void {
        const HEADER_SIZE = 16;

        while (this.connected && this.responseBuffer.length >= HEADER_SIZE) {
            const header = Deserializer.parseHeader(this.responseBuffer);
            if (!header) break;

            if (header.prefix !== SERDE_PREFIX) {
                if (this.pendingReject) {
                    this.pendingReject(new Error('Invalid response prefix'));
                    this.pendingResolve = null;
                    this.pendingReject = null;
                }
                this.responseBuffer = Buffer.alloc(0);
                break;
            }

            const totalSize = HEADER_SIZE + Number(header.size);
            if (this.responseBuffer.length < totalSize) break;

            const payload = this.responseBuffer.subarray(HEADER_SIZE, totalSize);
            this.responseBuffer = this.responseBuffer.subarray(totalSize);

            try {
                const deserializer = new Deserializer(payload);
                const value = deserializer.deserialize();

                if (header.msgtype === MSG_TYPE_RESP && this.pendingResolve) {
                    this.pendingResolve(value);
                    this.pendingResolve = null;
                    this.pendingReject = null;
                }
            } catch (err) {
                if (this.pendingReject) {
                    this.pendingReject(err instanceof Error ? err : new Error(String(err)));
                    this.pendingResolve = null;
                    this.pendingReject = null;
                }
            }
        }
    }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Format a Rayfall value for display (mimics native Rayfall REPL)
 */
export function formatValue(value: RayforceValue): string {
    if (value === null) {
        return '::';
    }

    if (typeof value === 'boolean') {
        return value ? '1b' : '0b';
    }

    if (typeof value === 'number') {
        if (Number.isNaN(value)) return '0n';
        if (!Number.isFinite(value)) return value > 0 ? '0w' : '-0w';
        return Number.isInteger(value) ? String(value) : String(value);
    }

    if (typeof value === 'bigint') {
        return String(value);
    }

    if (typeof value === 'string') {
        return `"${value}"`;
    }

    if (typeof value === 'symbol') {
        return '`' + (Symbol.keyFor(value) || '');
    }

    if (typeof value === 'object' && value !== null && '_type' in value) {
        if (value._type === 'date') {
            return formatDate(value);
        }
        if (value._type === 'time') {
            return formatTime(value);
        }
        if (value._type === 'timestamp') {
            return formatTimestamp(value);
        }
        if (value._type === 'error') {
            return `'${value.message}`;
        }
        if (value._type === 'table') {
            return formatTable(value);
        }
        if (value._type === 'dict') {
            return formatDict(value);
        }
    }

    if (Array.isArray(value)) {
        if (value.length === 0) {
            return '()';
        }
        // Format as space-separated values in brackets: [1 2 3 4]
        const items = value.map(v => formatValue(v));
        return `[${items.join(' ')}]`;
    }


    return String(value);
}

/**
 * Format a table with box-drawing characters (like native Rayfall REPL)
 */
function formatTable(table: RayforceTable): string {
    const columns = table.columns;
    const values = table.values;
    
    if (columns.length === 0) {
        return '(empty table)';
    }

    // Calculate row count
    const rowCount = Array.isArray(values) && values.length > 0 && Array.isArray(values[0]) 
        ? values[0].length 
        : 0;

    // Format all cell values
    const formattedCells: string[][] = [];
    const maxRows = Math.min(rowCount, 20);
    
    for (let row = 0; row < maxRows; row++) {
        const rowData: string[] = [];
        for (let col = 0; col < columns.length; col++) {
            const colData = values[col];
            const val = Array.isArray(colData) ? colData[row] : null;
            rowData.push(formatValue(val));
        }
        formattedCells.push(rowData);
    }

    // Calculate column widths
    const colWidths: number[] = columns.map((col, idx) => {
        let maxWidth = col.length;
        for (const row of formattedCells) {
            if (row[idx]) {
                maxWidth = Math.max(maxWidth, row[idx].length);
            }
        }
        return maxWidth;
    });

    // Footer text
    const shownRows = formattedCells.length;
    const shownCols = columns.length;
    const footer = `${rowCount} rows (${shownRows} shown) ${columns.length} columns (${shownCols} shown)`;

    // Calculate inner width (content between │ and │)
    // Content width = sum of column widths + separators between columns
    const contentWidth = colWidths.reduce((a, b) => a + b, 0) + (colWidths.length - 1) * 3;
    // Inner width must fit both content and footer
    const innerWidth = Math.max(contentWidth, footer.length);

    // Build table
    const lines: string[] = [];
    
    // Top border
    lines.push('┌' + '─'.repeat(innerWidth + 2) + '┐');
    
    // Header row
    const headerCells = columns.map((col, i) => col.padEnd(colWidths[i]));
    const headerContent = headerCells.join(' │ ');
    lines.push('│ ' + headerContent.padEnd(innerWidth) + ' │');
    
    // Header separator
    lines.push('├' + '─'.repeat(innerWidth + 2) + '┤');
    
    // Data rows
    for (const row of formattedCells) {
        const cells = row.map((cell, i) => cell.padEnd(colWidths[i]));
        const rowContent = cells.join(' │ ');
        lines.push('│ ' + rowContent.padEnd(innerWidth) + ' │');
    }
    
    // Footer separator
    lines.push('├' + '─'.repeat(innerWidth + 2) + '┤');
    
    // Footer with counts (centered)
    const leftPad = Math.floor((innerWidth - footer.length) / 2);
    const footerPadded = ' '.repeat(leftPad) + footer;
    lines.push('│ ' + footerPadded.padEnd(innerWidth) + ' │');
    
    // Bottom border
    lines.push('└' + '─'.repeat(innerWidth + 2) + '┘');

    return lines.join('\n');
}

/**
 * Format a dictionary
 */
function formatDict(dict: RayforceDict): string {
    const keys = formatValue(dict.keys);
    const values = formatValue(dict.values);
    return `${keys}!${values}`;
}

/**
 * Format a Rayforce Date (YYYY.MM.DD)
 * Based on date_fmt_into in format.c
 */
function formatDate(date: RayforceDate): string {
    // Convert days since 2000-01-01 to a JavaScript Date
    // Then format as YYYY.MM.DD
    const jsDate = new Date((date.value * MSECS_IN_DAY) + UT_EPOCH_SHIFT_MS);
    const year = jsDate.getUTCFullYear();
    const month = String(jsDate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(jsDate.getUTCDate()).padStart(2, '0');
    return `${year}.${month}.${day}`;
}

/**
 * Format a Rayforce Time (HH:MM:SS.mmm)
 * Based on time_fmt_into in format.c
 */
function formatTime(time: RayforceTime): string {
    const ms = time.value;
    const sign = ms < 0 ? -1 : 1;
    const absMs = Math.abs(ms);
    
    const totalSeconds = Math.floor(absMs / 1000);
    const milliseconds = absMs % 1000;
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    
    const hh = String(hours).padStart(2, '0');
    const mm = String(minutes).padStart(2, '0');
    const ss = String(seconds).padStart(2, '0');
    const mmm = String(milliseconds).padStart(3, '0');
    
    if (sign < 0) {
        return `-${hh}:${mm}:${ss}.${mmm}`;
    }
    return `${hh}:${mm}:${ss}.${mmm}`;
}

/**
 * Format a Rayforce Timestamp (YYYY.MM.DDDHH:MM:SS.nnnnnnnnn)
 * Based on timestamp_fmt_into in format.c
 */
function formatTimestamp(timestamp: RayforceTimestamp): string {
    // Convert nanoseconds since 2000-01-01 to milliseconds
    const milliseconds = Number(timestamp.value / BigInt(1000000));
    const jsDate = new Date(milliseconds + UT_EPOCH_SHIFT_MS);
    
    const year = jsDate.getUTCFullYear();
    const month = String(jsDate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(jsDate.getUTCDate()).padStart(2, '0');
    const hours = String(jsDate.getUTCHours()).padStart(2, '0');
    const minutes = String(jsDate.getUTCMinutes()).padStart(2, '0');
    const seconds = String(jsDate.getUTCSeconds()).padStart(2, '0');
    
    // Extract nanoseconds from the original value
    const nanos = Number(timestamp.value % BigInt(1000000000));
    const nanosStr = String(nanos).padStart(9, '0');
    
    return `${year}.${month}.${day}D${hours}:${minutes}:${seconds}.${nanosStr}`;
}

/**
 * Check if value is a Rayforce error
 */
export function isError(value: RayforceValue): value is RayforceError {
    return typeof value === 'object' && value !== null && '_type' in value && value._type === 'error';
}

