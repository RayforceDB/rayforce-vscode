/**
 * Rayforce IPC Client for TypeScript
 * Native implementation of the Rayforce wire protocol (version 3)
 * without external executable.
 *
 * Wire reference: rayforce src/store/serde.{h,c} and src/core/ipc.c.
 */

import * as net from 'net';

// ============================================================================
// Constants
// ============================================================================

// RAY_SERDE_WIRE_VERSION — the server refuses any other version at handshake
const RAYFORCE_WIRE_VERSION = 3;
const SERDE_PREFIX = 0xcefadefa;

// Message types
const MSG_TYPE_ASYNC = 0;
const MSG_TYPE_SYNC = 1;
const MSG_TYPE_RESP = 2;

// IPC header flags
const IPC_FLAG_COMPRESSED = 0x01;

// Atom flags byte (v3: every atom is type + flags + value bytes)
const ATOM_FLAG_NULL = 0x01; // typed-null marker

// Data types (wire v3 ids; atoms use the negated id)
const TYPE_LIST = 0;
const TYPE_B8 = 1;
const TYPE_U8 = 2;
const TYPE_I16 = 3;
const TYPE_I32 = 4;
const TYPE_I64 = 5;
const TYPE_F32 = 6;
const TYPE_F64 = 7;
const TYPE_DATE = 8;
const TYPE_TIME = 9;
const TYPE_TIMESTAMP = 10;
const TYPE_GUID = 11;
const TYPE_SYMBOL = 12;
const TYPE_STR = 13;
const TYPE_TABLE = 98;
const TYPE_DICT = 99;
const TYPE_LAMBDA = 100;
const TYPE_UNARY = 101;
const TYPE_BINARY = 102;
const TYPE_VARY = 103;
const TYPE_NULL = 126;
const TYPE_ERR = 127;

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
    | RayforceFunction
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

export interface RayforceFunction {
    _type: 'function';
    name: string | null;    // builtin name (null for lambdas)
    params: RayforceValue;  // lambda parameter list (null for builtins)
}

export interface RayforceError {
    _type: 'error';
    code: string;    // packed ASCII code, e.g. 'type', 'parse', 'oom'
    message: string; // same as code (v3 sends no detail text over the wire)
}

/** Thrown by connect() when the server requires credentials and none were given */
export class AuthRequiredError extends Error {
    constructor() {
        super('Authentication required');
        this.name = 'AuthRequiredError';
    }
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
     * Serialize a string value as a STR atom (the payload shape the server's
     * sync handler evaluates as source text)
     */
    static serializeString(str: string): Buffer {
        const strBytes = Buffer.from(str, 'utf8');
        const len = strBytes.length;

        // type (1) + flags (1) + length (8) + data
        const buf = Buffer.alloc(1 + 1 + 8 + len);
        let offset = 0;

        buf.writeInt8(-TYPE_STR, offset); offset += 1;
        buf.writeUInt8(0, offset); offset += 1; // atom flags
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
        msg.writeUInt8(RAYFORCE_WIRE_VERSION, offset); offset += 1;
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
// Compression (delta + RLE, mirrors ray_ipc_decompress in core/ipc.c)
// ============================================================================

/**
 * Decompress a compressed IPC payload: [u32 uncompressed size][RLE stream],
 * where the RLE stream encodes a delta-coded byte sequence.  A positive i8
 * count means "repeat next byte count times"; a non-positive count means
 * "copy -count literal bytes".  The delta code is undone by a prefix sum.
 */
function decompressPayload(payload: Buffer): Buffer {
    if (payload.length < 4) {
        throw new Error('Compressed payload too short');
    }
    const uncompSize = payload.readUInt32LE(0);
    if (uncompSize === 0 || uncompSize > 256 * 1024 * 1024) {
        throw new Error(`Invalid uncompressed size: ${uncompSize}`);
    }

    const out = Buffer.alloc(uncompSize);
    let si = 4;
    let di = 0;

    while (si < payload.length && di < uncompSize) {
        const count = payload.readInt8(si); si += 1;
        if (count > 0) {
            if (si >= payload.length || di + count > uncompSize) {
                throw new Error('Corrupted compressed payload');
            }
            out.fill(payload[si], di, di + count);
            si += 1;
            di += count;
        } else {
            const n = -count;
            if (si + n > payload.length || di + n > uncompSize) {
                throw new Error('Corrupted compressed payload');
            }
            payload.copy(out, di, si, si + n);
            si += n;
            di += n;
        }
    }

    if (di !== uncompSize) {
        throw new Error(`Decompressed size mismatch: got ${di}, expected ${uncompSize}`);
    }

    // Un-delta (prefix sum mod 256)
    for (let i = 1; i < uncompSize; i++) {
        out[i] = (out[i] + out[i - 1]) & 0xff;
    }

    return out;
}

// ============================================================================
// Deserialization
// ============================================================================

// Rayforce epoch constants (from temporal.h)
const RAYFORCE_EPOCH_YEAR = 2000;
const UT_EPOCH_SHIFT_MS = 946684800 * 1000; // milliseconds from Unix epoch (1970-01-01) to Rayforce epoch (2000-01-01)
const MSECS_IN_DAY = 24 * 60 * 60 * 1000;
const NSECS_IN_DAY = BigInt(24 * 60 * 60) * BigInt(1000000000);

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

    readFloatLE(): number {
        const val = this.buf.readFloatLE(this.offset);
        this.offset += 4;
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

        if (type === TYPE_NULL) {
            return null;
        }

        // Atoms (negative types)
        if (type < 0) {
            return this.deserializeAtom(-type);
        }

        switch (type) {
            // Vectors (positive types)
            case TYPE_B8:
            case TYPE_U8:
            case TYPE_I16:
            case TYPE_I32:
            case TYPE_F32:
            case TYPE_DATE:
            case TYPE_TIME:
            case TYPE_I64:
            case TYPE_TIMESTAMP:
            case TYPE_F64:
            case TYPE_SYMBOL:
            case TYPE_STR:
            case TYPE_GUID:
            case TYPE_LIST:
                return this.deserializeVector(type);

            case TYPE_TABLE:
                return this.deserializeTable();

            case TYPE_DICT:
                return this.deserializeDict();

            case TYPE_LAMBDA:
                return this.deserializeLambda();

            case TYPE_UNARY:
            case TYPE_BINARY:
            case TYPE_VARY:
                return this.deserializeBuiltin();

            case TYPE_ERR:
                return this.deserializeError();

            default:
                throw new Error(`Unsupported type: ${type}`);
        }
    }

    /**
     * Deserialize an atom: flags byte + value bytes.  Flags bit 0 marks a
     * typed null (the value bytes still carry the sentinel).
     */
    private deserializeAtom(base: number): RayforceValue {
        const flags = this.readUInt8();
        const isNull = (flags & ATOM_FLAG_NULL) !== 0;

        switch (base) {
            case TYPE_B8: {
                const v = this.readInt8() !== 0;
                return isNull ? null : v;
            }
            case TYPE_U8: {
                const v = this.readUInt8();
                return isNull ? null : v;
            }
            case TYPE_I16: {
                const v = this.readInt16LE();
                return isNull ? null : v;
            }
            case TYPE_I32: {
                const v = this.readInt32LE();
                return isNull ? null : v;
            }
            case TYPE_F32: {
                const v = this.readFloatLE();
                return isNull ? null : v;
            }
            case TYPE_F64: {
                const v = this.readDoubleLE();
                return isNull ? null : v;
            }
            case TYPE_DATE: {
                const v = this.readInt32LE();
                return isNull ? null : dateFromI32(v);
            }
            case TYPE_TIME: {
                const v = this.readInt32LE();
                return isNull ? null : timeFromI32(v);
            }
            case TYPE_I64: {
                const v = this.readBigInt64LE();
                return isNull ? null : v;
            }
            case TYPE_TIMESTAMP: {
                const v = this.readBigInt64LE();
                return isNull ? null : timestampFromI64(v);
            }
            case TYPE_SYMBOL: {
                const s = this.readNullTerminatedString();
                return isNull ? null : Symbol.for(s);
            }
            case TYPE_STR: {
                const len = Number(this.readBigInt64LE());
                const s = this.readBuffer(len).toString('utf8');
                return isNull ? null : s;
            }
            case TYPE_GUID: {
                const hex = this.readBuffer(16).toString('hex');
                return isNull ? null : hex;
            }
            default:
                throw new Error(`Unsupported atom type: ${-base}`);
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

            case TYPE_I16:
                return Array.from({ length: len }, () => this.readInt16LE());

            case TYPE_I32:
                return Array.from({ length: len }, () => this.readInt32LE());

            case TYPE_F32:
                return Array.from({ length: len }, () => this.readFloatLE());

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

            case TYPE_STR:
                // Each cell is an i64 length followed by raw utf8 bytes
                return Array.from({ length: len }, () => {
                    const slen = Number(this.readBigInt64LE());
                    return this.readBuffer(slen).toString('utf8');
                });

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

        // Peek the type byte for the name; deserialize() consumes it
        const type = this.buf.readInt8(this.offset);
        return { value: this.deserialize(), typeName: this.getTypeName(type) };
    }

    private getTypeName(type: number): string {
        const typeNames: { [key: number]: string } = {
            [TYPE_NULL]: 'Null',
            [-TYPE_B8]: 'B8', [TYPE_B8]: 'B8',
            [-TYPE_U8]: 'U8', [TYPE_U8]: 'U8',
            [-TYPE_I16]: 'I16', [TYPE_I16]: 'I16',
            [-TYPE_I32]: 'I32', [TYPE_I32]: 'I32',
            [-TYPE_I64]: 'I64', [TYPE_I64]: 'I64',
            [-TYPE_F32]: 'F32', [TYPE_F32]: 'F32',
            [-TYPE_F64]: 'F64', [TYPE_F64]: 'F64',
            [-TYPE_STR]: 'String', [TYPE_STR]: 'String',
            [-TYPE_SYMBOL]: 'Symbol', [TYPE_SYMBOL]: 'Symbol',
            [-TYPE_DATE]: 'Date', [TYPE_DATE]: 'Date',
            [-TYPE_TIME]: 'Time', [TYPE_TIME]: 'Time',
            [-TYPE_TIMESTAMP]: 'Timestamp', [TYPE_TIMESTAMP]: 'Timestamp',
            [-TYPE_GUID]: 'GUID', [TYPE_GUID]: 'GUID',
            [TYPE_LIST]: 'List',
            [TYPE_TABLE]: 'Table',
            [TYPE_DICT]: 'Dict',
            [TYPE_ERR]: 'Error',
            [TYPE_LAMBDA]: 'Lambda',
            [TYPE_UNARY]: 'Lambda',
            [TYPE_BINARY]: 'Lambda',
            [TYPE_VARY]: 'Lambda'
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

    private deserializeLambda(): RayforceFunction {
        this.readUInt8(); // skip attrs
        const params = this.deserialize();
        this.deserialize(); // body — consumed but not represented

        return {
            _type: 'function',
            name: null,
            params
        };
    }

    private deserializeBuiltin(): RayforceFunction {
        // Builtins serialize by name: null-terminated string, no attrs byte
        return {
            _type: 'function',
            name: this.readNullTerminatedString(),
            params: null
        };
    }

    private deserializeError(): RayforceError {
        // 8 bytes: up to 7 chars of packed ASCII code, NUL-padded
        const raw = this.readBuffer(8);
        let end = raw.indexOf(0);
        if (end < 0) end = raw.length;
        const code = raw.toString('ascii', 0, end);

        return {
            _type: 'error',
            code,
            message: code
        };
    }
}

// ============================================================================
// IPC Client
// ============================================================================

interface PendingRequest {
    statement: string;
    timeout: number;
    resolve: (value: RayforceValue) => void;
    reject: (reason: Error) => void;
}

export class RayforceIpcClient {
    private socket: net.Socket | null = null;
    private host: string;
    private port: number;
    private connected: boolean = false;
    private responseBuffer: Buffer = Buffer.alloc(0);
    private pendingResolve: ((value: RayforceValue) => void) | null = null;
    private pendingReject: ((reason: Error) => void) | null = null;

    // The wire protocol carries no request id: a RESP is correlated to a
    // request purely by being the next thing to arrive on the socket after
    // it was sent.  So at most one SYNC request may be in flight at a time;
    // concurrent execute() callers (e.g. a second command submitted before
    // the first one's result comes back) are queued and sent one by one,
    // instead of clobbering the single pendingResolve/pendingReject slot
    // and misattributing the next response to the wrong caller.
    private requestQueue: PendingRequest[] = [];
    private currentRequest: PendingRequest | null = null;
    private currentTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

    constructor(host: string, port: number) {
        this.host = host;
        this.port = port;
    }

    async connect(timeout: number = 5000, auth?: { user?: string; password?: string }): Promise<void> {
        return new Promise((resolve, reject) => {
            let settled = false;

            const settle = (fn: () => void) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timeoutHandle);
                    fn();
                }
            };

            const fail = (err: Error) => {
                settle(() => {
                    this.disconnect();
                    reject(err);
                });
            };

            const timeoutHandle = setTimeout(() => {
                fail(new Error(`Connection timeout after ${timeout}ms`));
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
                // Also settle the in-flight request and drain the queue
                this.rejectAll(new Error('Connection closed'));
            });

            // Handshake: send [version, 0]; server replies [version, auth_required].
            // If auth is required, send [len]["user:password\0"] and expect a
            // single 0x00 status byte back.  Replies may arrive split across
            // 'data' events, so accumulate bytes until each phase is complete.
            let hsBuffer = Buffer.alloc(0);
            let hsPhase: 'version' | 'auth' = 'version';

            const enterStreaming = (leftover: Buffer) => {
                this.connected = true;
                this.socket!.removeListener('data', onHandshakeData);
                this.socket!.on('data', (d) => this.handleData(d));

                if (leftover.length > 0) {
                    this.responseBuffer = Buffer.concat([this.responseBuffer, leftover]);
                    this.tryProcessResponse();
                }
                resolve();
            };

            const onHandshakeData = (data: Buffer) => {
                hsBuffer = Buffer.concat([hsBuffer, data]);

                if (hsPhase === 'version') {
                    if (hsBuffer.length < 2) return;

                    const version = hsBuffer[0];
                    const authRequired = hsBuffer[1];
                    if (version !== RAYFORCE_WIRE_VERSION) {
                        fail(new Error(`Server speaks wire protocol v${version}, this client requires v${RAYFORCE_WIRE_VERSION}`));
                        return;
                    }

                    hsBuffer = hsBuffer.subarray(2);

                    if (authRequired === 0x00) {
                        settle(() => enterStreaming(hsBuffer));
                        return;
                    }
                    if (authRequired !== 0x01) {
                        fail(new Error('Invalid handshake response'));
                        return;
                    }

                    if (!auth || !auth.password) {
                        fail(new AuthRequiredError());
                        return;
                    }

                    // "user:password" with the null terminator counted in len
                    const cred = Buffer.from(`${auth.user || ''}:${auth.password}\0`, 'utf8');
                    if (cred.length > 255) {
                        fail(new Error('Credentials too long'));
                        return;
                    }

                    hsPhase = 'auth';
                    this.socket!.write(Buffer.concat([Buffer.from([cred.length]), cred]));
                }

                if (hsPhase === 'auth') {
                    if (hsBuffer.length < 1) return;

                    if (hsBuffer[0] !== 0x00) {
                        fail(new Error('Authentication rejected'));
                        return;
                    }
                    settle(() => enterStreaming(hsBuffer.subarray(1)));
                }
            };

            this.socket.connect(this.port, this.host, () => {
                const handshake = Buffer.from([RAYFORCE_WIRE_VERSION, 0]);

                this.socket!.write(handshake, (writeErr) => {
                    if (writeErr) {
                        fail(writeErr);
                        return;
                    }
                    this.socket!.on('data', onHandshakeData);
                });
            });
        });
    }

    disconnect(): void {
        // Clear the in-flight request and drain anything still queued —
        // otherwise a queued caller would hang until its own timeout fires
        // on a socket that will never receive a reply.
        this.rejectAll(new Error('Disconnected'));

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

    /**
     * Reject the in-flight request (if any) and every queued request.
     * Clears state directly rather than going through the pendingReject
     * wire-closure, so this never re-enters pumpQueue() and tries to write
     * to a socket that's mid-teardown — after a disconnect there is nothing
     * left to pump until a future execute() call starts a new request.
     */
    private rejectAll(err: Error): void {
        if (this.currentTimeoutHandle) {
            clearTimeout(this.currentTimeoutHandle);
            this.currentTimeoutHandle = null;
        }
        const current = this.currentRequest;
        this.currentRequest = null;
        this.pendingResolve = null;
        this.pendingReject = null;

        const queued = this.requestQueue;
        this.requestQueue = [];

        if (current) {
            current.reject(err);
        }
        for (const req of queued) {
            req.reject(err);
        }
    }

    async execute(statement: string, timeout: number = 30000): Promise<RayforceValue> {
        if (!this.isConnected()) {
            throw new Error('Not connected to Rayforce instance');
        }

        return new Promise((resolve, reject) => {
            this.requestQueue.push({ statement, timeout, resolve, reject });
            this.pumpQueue();
        });
    }

    /**
     * Send the next queued request, if the wire is free.  Only one SYNC
     * request may be outstanding at a time (see the requestQueue comment
     * above), so this is a no-op while currentRequest is set; whichever
     * settles the current request (response, timeout, or write error) calls
     * finishCurrent(), which advances the queue.
     */
    private pumpQueue(): void {
        if (this.currentRequest || this.requestQueue.length === 0) {
            return;
        }
        if (!this.isConnected()) {
            // Socket died between enqueue and pump.  rejectAll() already
            // drains the queue on disconnect/'close', so this is normally
            // unreachable — kept as a guard since this.socket!.write below
            // would otherwise throw on a null socket.
            this.rejectAll(new Error('Not connected to Rayforce instance'));
            return;
        }

        const request = this.requestQueue.shift()!;
        this.currentRequest = request;

        this.currentTimeoutHandle = setTimeout(() => {
            this.finishCurrent(request, () => request.reject(new Error(`Execution timeout after ${request.timeout}ms`)));
        }, request.timeout);

        this.pendingResolve = (value) => {
            this.finishCurrent(request, () => request.resolve(value));
        };

        this.pendingReject = (err) => {
            this.finishCurrent(request, () => request.reject(err));
        };

        const payload = Serializer.serializeString(request.statement);
        const message = Serializer.createMessage(payload, MSG_TYPE_SYNC);

        this.socket!.write(message, (err) => {
            if (err) {
                this.finishCurrent(request, () => request.reject(err));
            }
        });
    }

    /**
     * Settle `request` and advance the queue.  A no-op if `request` is no
     * longer the current one — guards against a stale timeout or write-error
     * callback firing after rejectAll() already cleared it (e.g. the socket
     * closed and a new request has since started).
     */
    private finishCurrent(request: PendingRequest, fn: () => void): void {
        if (this.currentRequest !== request) {
            return;
        }
        if (this.currentTimeoutHandle) {
            clearTimeout(this.currentTimeoutHandle);
            this.currentTimeoutHandle = null;
        }
        this.currentRequest = null;
        this.pendingResolve = null;
        this.pendingReject = null;
        fn();
        this.pumpQueue();
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
                // pendingReject (if set) is the finishCurrent-wrapped closure
                // installed by pumpQueue(): invoking it clears the fields and
                // advances to the next queued request itself, so this must
                // not also null them afterward — that would stomp on the
                // next request's just-installed pendingResolve/pendingReject.
                if (this.pendingReject) {
                    this.pendingReject(new Error('Invalid response prefix'));
                }
                this.responseBuffer = Buffer.alloc(0);
                break;
            }

            const totalSize = HEADER_SIZE + Number(header.size);
            if (this.responseBuffer.length < totalSize) break;

            const rawPayload = this.responseBuffer.subarray(HEADER_SIZE, totalSize);
            this.responseBuffer = this.responseBuffer.subarray(totalSize);

            try {
                const payload = (header.flags & IPC_FLAG_COMPRESSED) !== 0
                    ? decompressPayload(rawPayload)
                    : rawPayload;
                const deserializer = new Deserializer(payload);
                const value = deserializer.deserialize();

                // See the comment on the invalid-prefix branch above: these
                // closures own clearing/advancing the queue themselves.
                if (header.msgtype === MSG_TYPE_RESP && this.pendingResolve) {
                    this.pendingResolve(value);
                }
            } catch (err) {
                if (this.pendingReject) {
                    this.pendingReject(err instanceof Error ? err : new Error(String(err)));
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
        if (value === NULL_I64) return '0N';
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
        if (value._type === 'function') {
            return value.name || 'fn';
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
 * Format a timestamp value (i64 nanoseconds since 2000-01-01) as
 * YYYY.MM.DDDHH:MM:SS.nnnnnnnnn, exactly like the native REPL
 * (ts_to_parts in format.c).
 *
 * The day/intra-day split must be floored, not truncated: BigInt `/` and
 * `%` truncate toward zero, so for pre-2000 (negative) values a plain
 * split lands on the wrong day and yields a negative nanosecond remainder
 * (rendered as garbage like "2000.01.01D00:00:00.0000000-1").
 */
export function formatTimestampString(nanoseconds: bigint): string {
    let days = nanoseconds / NSECS_IN_DAY;
    let span = nanoseconds % NSECS_IN_DAY;
    if (span < BigInt(0)) {
        days -= BigInt(1);
        span += NSECS_IN_DAY;
    }

    // Days since 2000-01-01 → calendar date (exact: |days| * MSECS_IN_DAY
    // is far below 2^53)
    const jsDate = new Date(Number(days) * MSECS_IN_DAY + UT_EPOCH_SHIFT_MS);
    const year = String(jsDate.getUTCFullYear()).padStart(4, '0');
    const month = String(jsDate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(jsDate.getUTCDate()).padStart(2, '0');

    const secs = span / BigInt(1000000000);
    const nanos = span % BigInt(1000000000);
    const hours = String(secs / BigInt(3600)).padStart(2, '0');
    const minutes = String((secs % BigInt(3600)) / BigInt(60)).padStart(2, '0');
    const seconds = String(secs % BigInt(60)).padStart(2, '0');
    const nanosStr = String(nanos).padStart(9, '0');

    return `${year}.${month}.${day}D${hours}:${minutes}:${seconds}.${nanosStr}`;
}

/**
 * Format a Rayforce Timestamp (YYYY.MM.DDDHH:MM:SS.nnnnnnnnn)
 * Based on timestamp_fmt_into in format.c
 */
function formatTimestamp(timestamp: RayforceTimestamp): string {
    return formatTimestampString(timestamp.value);
}

/**
 * Check if value is a Rayforce error
 */
export function isError(value: RayforceValue): value is RayforceError {
    return typeof value === 'object' && value !== null && '_type' in value && value._type === 'error';
}
