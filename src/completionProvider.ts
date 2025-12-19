import * as vscode from 'vscode';

// Rayforce built-in definitions extracted from core/env.c
export interface RayforceSymbol {
    name: string;
    kind: 'keyword' | 'function' | 'type' | 'constant';
    detail: string;
    documentation?: string;
}

// Keywords and special forms
const keywords: RayforceSymbol[] = [
    { name: 'fn', kind: 'keyword', detail: 'Define anonymous function', documentation: '(fn [args] body)' },
    { name: 'do', kind: 'keyword', detail: 'Execute multiple expressions', documentation: '(do expr1 expr2 ...)' },
    { name: 'set', kind: 'keyword', detail: 'Bind value to symbol', documentation: '(set name value)' },
    { name: 'let', kind: 'keyword', detail: 'Local binding', documentation: '(let [bindings] body)' },
    { name: 'if', kind: 'keyword', detail: 'Conditional expression', documentation: '(if condition then-expr else-expr)' },
    { name: 'and', kind: 'keyword', detail: 'Logical AND (short-circuit)', documentation: '(and expr1 expr2 ...)' },
    { name: 'or', kind: 'keyword', detail: 'Logical OR (short-circuit)', documentation: '(or expr1 expr2 ...)' },
    { name: 'try', kind: 'keyword', detail: 'Try-catch expression', documentation: '(try expr handler)' },
    { name: 'quote', kind: 'keyword', detail: 'Quote expression', documentation: '(quote expr) or \'expr' },
    { name: 'self', kind: 'keyword', detail: 'Self-reference in recursive fn', documentation: '(self args...)' },
    { name: 'timeit', kind: 'keyword', detail: 'Measure execution time', documentation: '(timeit expr)' },
];

// Unary functions
const unaryFunctions: RayforceSymbol[] = [
    { name: 'get', kind: 'function', detail: 'Get value', documentation: '(get x)' },
    { name: 'raise', kind: 'function', detail: 'Raise an error', documentation: '(raise msg)' },
    { name: 'read', kind: 'function', detail: 'Read from file', documentation: '(read path)' },
    { name: 'parse', kind: 'function', detail: 'Parse string to expression', documentation: '(parse str)' },
    { name: 'eval', kind: 'function', detail: 'Evaluate expression', documentation: '(eval expr)' },
    { name: 'load', kind: 'function', detail: 'Load and execute file', documentation: '(load path)' },
    { name: 'type', kind: 'function', detail: 'Get type of value', documentation: '(type x)' },
    { name: 'til', kind: 'function', detail: 'Generate range 0..n-1', documentation: '(til n) → [0 1 2 ... n-1]' },
    { name: 'reverse', kind: 'function', detail: 'Reverse list/vector', documentation: '(reverse x)' },
    { name: 'distinct', kind: 'function', detail: 'Get unique values', documentation: '(distinct x)' },
    { name: 'group', kind: 'function', detail: 'Group by values', documentation: '(group x)' },
    { name: 'sum', kind: 'function', detail: 'Sum of values', documentation: '(sum x)' },
    { name: 'avg', kind: 'function', detail: 'Average of values', documentation: '(avg x)' },
    { name: 'med', kind: 'function', detail: 'Median of values', documentation: '(med x)' },
    { name: 'dev', kind: 'function', detail: 'Standard deviation', documentation: '(dev x)' },
    { name: 'min', kind: 'function', detail: 'Minimum value', documentation: '(min x)' },
    { name: 'max', kind: 'function', detail: 'Maximum value', documentation: '(max x)' },
    { name: 'round', kind: 'function', detail: 'Round to nearest integer', documentation: '(round x)' },
    { name: 'floor', kind: 'function', detail: 'Round down', documentation: '(floor x)' },
    { name: 'ceil', kind: 'function', detail: 'Round up', documentation: '(ceil x)' },
    { name: 'first', kind: 'function', detail: 'First element', documentation: '(first x)' },
    { name: 'last', kind: 'function', detail: 'Last element', documentation: '(last x)' },
    { name: 'count', kind: 'function', detail: 'Count elements', documentation: '(count x)' },
    { name: 'not', kind: 'function', detail: 'Logical NOT', documentation: '(not x)' },
    { name: 'iasc', kind: 'function', detail: 'Indices for ascending sort', documentation: '(iasc x)' },
    { name: 'idesc', kind: 'function', detail: 'Indices for descending sort', documentation: '(idesc x)' },
    { name: 'rank', kind: 'function', detail: 'Rank values', documentation: '(rank x)' },
    { name: 'asc', kind: 'function', detail: 'Sort ascending', documentation: '(asc x)' },
    { name: 'desc', kind: 'function', detail: 'Sort descending', documentation: '(desc x)' },
    { name: 'guid', kind: 'function', detail: 'Generate GUID(s)', documentation: '(guid n)' },
    { name: 'neg', kind: 'function', detail: 'Negate value', documentation: '(neg x)' },
    { name: 'where', kind: 'function', detail: 'Indices where true', documentation: '(where x)' },
    { name: 'key', kind: 'function', detail: 'Get keys of dict/table', documentation: '(key x)' },
    { name: 'value', kind: 'function', detail: 'Get values of dict/table', documentation: '(value x)' },
    { name: 'ser', kind: 'function', detail: 'Serialize to bytes', documentation: '(ser x)' },
    { name: 'de', kind: 'function', detail: 'Deserialize from bytes', documentation: '(de x)' },
    { name: 'hclose', kind: 'function', detail: 'Close handle', documentation: '(hclose h)' },
    { name: 'rc', kind: 'function', detail: 'Reference count', documentation: '(rc x)' },
    { name: 'select', kind: 'function', detail: 'Query table', documentation: '(select {cols from: t where: cond by: group})' },
    { name: 'update', kind: 'function', detail: 'Update table', documentation: '(update {cols from: t where: cond})' },
    { name: 'date', kind: 'function', detail: 'Convert to date', documentation: '(date x)' },
    { name: 'time', kind: 'function', detail: 'Convert to time', documentation: '(time x)' },
    { name: 'timestamp', kind: 'function', detail: 'Convert to timestamp', documentation: '(timestamp x)' },
    { name: 'nil?', kind: 'function', detail: 'Check if null', documentation: '(nil? x)' },
    { name: 'resolve', kind: 'function', detail: 'Resolve symbol', documentation: '(resolve sym)' },
    { name: 'show', kind: 'function', detail: 'Display value', documentation: '(show x)' },
    { name: 'meta', kind: 'function', detail: 'Get metadata', documentation: '(meta x)' },
    { name: 'os-get-var', kind: 'function', detail: 'Get environment variable', documentation: '(os-get-var name)' },
    { name: 'system', kind: 'function', detail: 'Execute system command', documentation: '(system cmd)' },
    { name: 'unify', kind: 'function', detail: 'Unify types in list', documentation: '(unify x)' },
    { name: 'raze', kind: 'function', detail: 'Flatten nested list', documentation: '(raze x)' },
    { name: 'diverse', kind: 'function', detail: 'Check if values are diverse', documentation: '(diverse x)' },
    { name: 'row', kind: 'function', detail: 'Get row from table', documentation: '(row x)' },
];

// Binary functions
const binaryFunctions: RayforceSymbol[] = [
    { name: 'write', kind: 'function', detail: 'Write to file', documentation: '(write path data)' },
    { name: 'at', kind: 'function', detail: 'Index into collection', documentation: '(at collection index)' },
    { name: '==', kind: 'function', detail: 'Equal', documentation: '(== x y)' },
    { name: '<', kind: 'function', detail: 'Less than', documentation: '(< x y)' },
    { name: '>', kind: 'function', detail: 'Greater than', documentation: '(> x y)' },
    { name: '<=', kind: 'function', detail: 'Less or equal', documentation: '(<= x y)' },
    { name: '>=', kind: 'function', detail: 'Greater or equal', documentation: '(>= x y)' },
    { name: '!=', kind: 'function', detail: 'Not equal', documentation: '(!= x y)' },
    { name: '+', kind: 'function', detail: 'Add', documentation: '(+ x y)' },
    { name: '-', kind: 'function', detail: 'Subtract', documentation: '(- x y)' },
    { name: '*', kind: 'function', detail: 'Multiply', documentation: '(* x y)' },
    { name: '%', kind: 'function', detail: 'Modulo', documentation: '(% x y)' },
    { name: '/', kind: 'function', detail: 'Divide', documentation: '(/ x y)' },
    { name: 'div', kind: 'function', detail: 'Integer division', documentation: '(div x y)' },
    { name: 'like', kind: 'function', detail: 'Pattern matching', documentation: '(like str pattern)' },
    { name: 'dict', kind: 'function', detail: 'Create dictionary', documentation: '(dict keys values)' },
    { name: 'table', kind: 'function', detail: 'Create table', documentation: '(table columns data)' },
    { name: 'find', kind: 'function', detail: 'Find index of value', documentation: '(find collection value)' },
    { name: 'concat', kind: 'function', detail: 'Concatenate', documentation: '(concat x y)' },
    { name: 'remove', kind: 'function', detail: 'Remove elements', documentation: '(remove collection indices)' },
    { name: 'filter', kind: 'function', detail: 'Filter by predicate', documentation: '(filter pred collection)' },
    { name: 'take', kind: 'function', detail: 'Take n elements', documentation: '(take n collection) or (take source count)' },
    { name: 'in', kind: 'function', detail: 'Membership test', documentation: '(in x collection)' },
    { name: 'within', kind: 'function', detail: 'Range test', documentation: '(within x [lo hi])' },
    { name: 'sect', kind: 'function', detail: 'Intersection', documentation: '(sect x y)' },
    { name: 'except', kind: 'function', detail: 'Set difference', documentation: '(except x y)' },
    { name: 'union', kind: 'function', detail: 'Set union', documentation: '(union x y)' },
    { name: 'rand', kind: 'function', detail: 'Random values', documentation: '(rand n max)' },
    { name: 'as', kind: 'function', detail: 'Cast to type', documentation: "(as 'TYPE x)" },
    { name: 'xasc', kind: 'function', detail: 'Sort table ascending', documentation: '(xasc cols table)' },
    { name: 'xdesc', kind: 'function', detail: 'Sort table descending', documentation: '(xdesc cols table)' },
    { name: 'xrank', kind: 'function', detail: 'Rank with groups', documentation: '(xrank n x)' },
    { name: 'enum', kind: 'function', detail: 'Create enumeration', documentation: '(enum domain values)' },
    { name: 'xbar', kind: 'function', detail: 'Bar/bucket values', documentation: '(xbar n x)' },
    { name: 'os-set-var', kind: 'function', detail: 'Set environment variable', documentation: '(os-set-var name value)' },
    { name: 'split', kind: 'function', detail: 'Split string', documentation: '(split str delimiter)' },
    { name: 'bin', kind: 'function', detail: 'Binary search', documentation: '(bin sorted value)' },
    { name: 'binr', kind: 'function', detail: 'Binary search (right)', documentation: '(binr sorted value)' },
];

// Variadic functions
const variadicFunctions: RayforceSymbol[] = [
    { name: 'env', kind: 'function', detail: 'Get environment dict', documentation: '(env)' },
    { name: 'memstat', kind: 'function', detail: 'Memory statistics', documentation: '(memstat)' },
    { name: 'gc', kind: 'function', detail: 'Garbage collection', documentation: '(gc)' },
    { name: 'list', kind: 'function', detail: 'Create generic list', documentation: '(list a b c ...)' },
    { name: 'enlist', kind: 'function', detail: 'Enlist as single-element list', documentation: '(enlist x)' },
    { name: 'format', kind: 'function', detail: 'Format string', documentation: '(format "pattern" args...)' },
    { name: 'print', kind: 'function', detail: 'Print without newline', documentation: '(print args...)' },
    { name: 'println', kind: 'function', detail: 'Print with newline', documentation: '(println args...)' },
    { name: 'apply', kind: 'function', detail: 'Apply function to args', documentation: '(apply fn args)' },
    { name: 'map', kind: 'function', detail: 'Map function over collection', documentation: '(map fn collection)' },
    { name: 'pmap', kind: 'function', detail: 'Parallel map', documentation: '(pmap fn collection)' },
    { name: 'map-left', kind: 'function', detail: 'Map with fixed left arg', documentation: '(map-left fn x y)' },
    { name: 'map-right', kind: 'function', detail: 'Map with fixed right arg', documentation: '(map-right fn x y)' },
    { name: 'fold', kind: 'function', detail: 'Reduce with binary fn', documentation: '(fold fn init collection)' },
    { name: 'fold-left', kind: 'function', detail: 'Left fold', documentation: '(fold-left fn init collection)' },
    { name: 'fold-right', kind: 'function', detail: 'Right fold', documentation: '(fold-right fn init collection)' },
    { name: 'scan', kind: 'function', detail: 'Scan (running fold)', documentation: '(scan fn init collection)' },
    { name: 'scan-left', kind: 'function', detail: 'Left scan', documentation: '(scan-left fn init collection)' },
    { name: 'scan-right', kind: 'function', detail: 'Right scan', documentation: '(scan-right fn init collection)' },
    { name: 'args', kind: 'function', detail: 'Command line arguments', documentation: '(args)' },
    { name: 'alter', kind: 'function', detail: 'Alter value in-place', documentation: "(alter 'var fn args...)" },
    { name: 'modify', kind: 'function', detail: 'Modify value', documentation: '(modify x fn args...)' },
    { name: 'insert', kind: 'function', detail: 'Insert row into table', documentation: '(insert table row)' },
    { name: 'upsert', kind: 'function', detail: 'Upsert into table', documentation: '(upsert table key data)' },
    { name: 'read-csv', kind: 'function', detail: 'Read CSV file', documentation: '(read-csv path types)' },
    { name: 'write-csv', kind: 'function', detail: 'Write CSV file', documentation: '(write-csv path table)' },
    { name: 'left-join', kind: 'function', detail: 'Left join tables', documentation: '(left-join [keys] left right)' },
    { name: 'inner-join', kind: 'function', detail: 'Inner join tables', documentation: '(inner-join [keys] left right)' },
    { name: 'asof-join', kind: 'function', detail: 'As-of join tables', documentation: '(asof-join [keys] left right)' },
    { name: 'window-join', kind: 'function', detail: 'Window join', documentation: '(window-join [keys] windows left right aggs)' },
    { name: 'window-join1', kind: 'function', detail: 'Window join variant', documentation: '(window-join1 ...)' },
    { name: 'return', kind: 'function', detail: 'Return from function', documentation: '(return value)' },
    { name: 'hopen', kind: 'function', detail: 'Open handle', documentation: '(hopen target)' },
    { name: 'exit', kind: 'function', detail: 'Exit runtime', documentation: '(exit code)' },
    { name: 'loadfn', kind: 'function', detail: 'Load dynamic function', documentation: '(loadfn lib name)' },
    { name: 'timer', kind: 'function', detail: 'Set timer callback', documentation: '(timer ms fn)' },
    { name: 'set-splayed', kind: 'function', detail: 'Save splayed table', documentation: '(set-splayed path table)' },
    { name: 'get-splayed', kind: 'function', detail: 'Load splayed table', documentation: '(get-splayed path)' },
    { name: 'set-parted', kind: 'function', detail: 'Save partitioned table', documentation: '(set-parted path table col)' },
    { name: 'get-parted', kind: 'function', detail: 'Load partitioned table', documentation: '(get-parted path)' },
    { name: 'internals', kind: 'function', detail: 'Get internal values', documentation: '(internals)' },
    { name: 'sysinfo', kind: 'function', detail: 'System information', documentation: '(sysinfo)' },
];

// Types
const types: RayforceSymbol[] = [
    { name: 'b8', kind: 'type', detail: 'Boolean (8-bit)' },
    { name: 'u8', kind: 'type', detail: 'Unsigned 8-bit integer' },
    { name: 'i16', kind: 'type', detail: 'Signed 16-bit integer' },
    { name: 'i32', kind: 'type', detail: 'Signed 32-bit integer' },
    { name: 'i64', kind: 'type', detail: 'Signed 64-bit integer' },
    { name: 'f64', kind: 'type', detail: 'Float 64-bit' },
    { name: 'c8', kind: 'type', detail: 'Character (8-bit)' },
    { name: 'symbol', kind: 'type', detail: 'Symbol type' },
    { name: 'date', kind: 'type', detail: 'Date type' },
    { name: 'time', kind: 'type', detail: 'Time type' },
    { name: 'timestamp', kind: 'type', detail: 'Timestamp type' },
    { name: 'guid', kind: 'type', detail: 'GUID type' },
    // Uppercase types (for casting)
    { name: 'B8', kind: 'type', detail: 'Boolean vector' },
    { name: 'U8', kind: 'type', detail: 'Unsigned 8-bit vector' },
    { name: 'I16', kind: 'type', detail: '16-bit integer vector' },
    { name: 'I32', kind: 'type', detail: '32-bit integer vector' },
    { name: 'I64', kind: 'type', detail: '64-bit integer vector' },
    { name: 'F64', kind: 'type', detail: 'Float 64-bit vector' },
    { name: 'C8', kind: 'type', detail: 'Character vector (string)' },
    { name: 'SYMBOL', kind: 'type', detail: 'Symbol vector' },
    { name: 'DATE', kind: 'type', detail: 'Date vector' },
    { name: 'TIME', kind: 'type', detail: 'Time vector' },
    { name: 'TIMESTAMP', kind: 'type', detail: 'Timestamp vector' },
    { name: 'GUID', kind: 'type', detail: 'GUID vector' },
    { name: 'LIST', kind: 'type', detail: 'Generic list' },
    { name: 'TABLE', kind: 'type', detail: 'Table type' },
    { name: 'DICT', kind: 'type', detail: 'Dictionary type' },
    { name: 'LAMBDA', kind: 'type', detail: 'Lambda/function type' },
];

// Constants
const constants: RayforceSymbol[] = [
    { name: 'nil', kind: 'constant', detail: 'Null value' },
    { name: 'true', kind: 'constant', detail: 'Boolean true (1b)' },
    { name: 'false', kind: 'constant', detail: 'Boolean false (0b)' },
];

// Query keywords (used in select/update expressions)
const queryKeywords: RayforceSymbol[] = [
    { name: 'from:', kind: 'keyword', detail: 'Source table', documentation: 'from: tablename' },
    { name: 'where:', kind: 'keyword', detail: 'Filter condition', documentation: 'where: (condition)' },
    { name: 'by:', kind: 'keyword', detail: 'Group by columns', documentation: 'by: column' },
    { name: 'take:', kind: 'keyword', detail: 'Limit rows', documentation: 'take: n' },
];

// All symbols combined
export const allSymbols: RayforceSymbol[] = [
    ...keywords,
    ...unaryFunctions,
    ...binaryFunctions,
    ...variadicFunctions,
    ...types,
    ...constants,
    ...queryKeywords,
];

// Export for REPL
export function getCompletionData(): { name: string; kind: string; detail: string; doc?: string }[] {
    return allSymbols.map(s => ({
        name: s.name,
        kind: s.kind,
        detail: s.detail,
        doc: s.documentation
    }));
}

function getCompletionItemKind(kind: string): vscode.CompletionItemKind {
    switch (kind) {
        case 'keyword': return vscode.CompletionItemKind.Keyword;
        case 'function': return vscode.CompletionItemKind.Function;
        case 'type': return vscode.CompletionItemKind.Class;
        case 'constant': return vscode.CompletionItemKind.Constant;
        default: return vscode.CompletionItemKind.Text;
    }
}

export class RayforceCompletionProvider implements vscode.CompletionItemProvider {
    private completionItems: vscode.CompletionItem[];

    constructor() {
        this.completionItems = allSymbols.map(symbol => {
            const item = new vscode.CompletionItem(symbol.name, getCompletionItemKind(symbol.kind));
            item.detail = symbol.detail;
            if (symbol.documentation) {
                item.documentation = new vscode.MarkdownString(`\`\`\`rayforce\n${symbol.documentation}\n\`\`\``);
            }
            // Sort order: keywords first, then functions, then types
            item.sortText = symbol.kind === 'keyword' ? `0_${symbol.name}` :
                           symbol.kind === 'function' ? `1_${symbol.name}` :
                           symbol.kind === 'type' ? `2_${symbol.name}` :
                           `3_${symbol.name}`;
            return item;
        });
    }

    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        _context: vscode.CompletionContext
    ): vscode.CompletionItem[] {
        const line = document.lineAt(position).text;
        const linePrefix = line.substring(0, position.character);
        
        // Get the word being typed
        const wordMatch = linePrefix.match(/[a-zA-Z0-9_\-!?<>=+*/%]+$/);
        const prefix = wordMatch ? wordMatch[0] : '';

        // Check if we're after a quote (for type casting like 'TYPE)
        const isAfterQuote = linePrefix.endsWith("'") || linePrefix.match(/'[A-Z]*$/);
        
        if (isAfterQuote) {
            // Return only uppercase types for casting
            return this.completionItems.filter(item => 
                item.kind === vscode.CompletionItemKind.Class && 
                item.label.toString().match(/^[A-Z]/)
            );
        }

        // Check if inside a query expression {from: ... where: ... by: ...}
        const beforeCursor = line.substring(0, position.character);
        const isInQuery = beforeCursor.includes('{') && !beforeCursor.includes('}');
        
        if (isInQuery && (linePrefix.endsWith(' ') || linePrefix.endsWith('\n') || linePrefix.match(/[a-z]+:?\s*$/))) {
            // Inside query, suggest query keywords and functions
            return this.completionItems.filter(item =>
                item.label.toString().endsWith(':') ||
                item.kind === vscode.CompletionItemKind.Function
            );
        }

        // Standard completion - all items
        return this.completionItems;
    }
}

