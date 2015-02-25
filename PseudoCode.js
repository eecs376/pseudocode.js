/*

Pseudocode formater that uses a TeX-style grammar

As stated in the manual of Algorithms package, `Because the mechanisms used to
build the various algorithmic structures make it difficult to` use the most
intuitive grammar in ... we shall NOT strictly follow the format of our TeX
counterpart. Some details are improved to make it more natural.

The TeX-style pseudocode language (follows **algoritmic** environment) represented
in a context-free grammar:

    <pseudo>        :== ( <algorithm> | <algorithmic> )[0..n]

    <algorithm>     :== \begin{algorithm}
                        + ( <caption> | <algorithmic> )[0..n]
                        \end{algorithm}
    <caption>       :== \caption{ <close-text> }

    <algorithmic>   :== \begin{algorithmic}
                        + ( <ensure> | <require> | <block> )[0..n]
                        + \end{algorithmic}
    <require>       :== \REQUIRE + <open-text>
    <ensure>        :== \ENSURE + <open-text>

    <block>         :== ( <control> | <function>
                        | <statement> | <comment> | <call> )[0..n]

    <control>       :== <if> | <for> | <while>
    <if>            :== \IF{<cond>} + <block>
                        + ( \ELIF{<cond>} <block> )[0..n]
                        + ( \ELSE <block> )[0..1]
                        + \ENDIF
    <for>           :== \FOR{<cond>} + <block> + \ENDFOR
    <while>         :== \WHILE{<cond>} + <block> + \ENDWHILE

    <function>      :== \FUNCTION{<name>}{<params>} <block> \ENDFUNCTION
                        (same for <procedure>)

    <statement>     :== <state> |  <return> | <print>
    <state>         :== \STATE + <open-text>
    <return>        :== \RETURN + <open-text>
    <print>         :== \PRINT + <open-text>

    <comment>       :== \COMMENT{<close-text>}

    <call>          :== \CALL{<close-text>}

    <cond>          :== <close-text>
    <open-text>     :== <symbol> + <open-text> | { <close-text> } | <empty>
    <close-text>    :== <symbol> + <close-text> | { <close-text> } | <empty>

    <symbol>        :== <ordinary>[1..n] | <special>
                        | <size> | <font> | <bool> | <math>

    <special>       :== \\ | \{ | \} | \$ | \& | \# | \% | \_
    <bool>          :== \AND | \OR | \NOT | \TRUE | \FALSE
    <math>          :== \( + ... + \) | $ ... $
                                                --- to be handled by KaTeX

    <size>          :== \tiny | \scriptsize | \footnotesize | \small
                        | \normalsize | \large | \Large | \LARGE | \huge
                        | \HUGE
    <font>          :== \rmfamily | \sffamily | \ttfamily
                        | \upshape | \itshape | \slshape | \scshape
    <ordinary>      :== not any of \ { } $ & # % _
    <empty>         :==

There are many well-known ways to parse a context-free grammar, like the
top-down approach LL(k) or the bottom-up approach like LR(k). Both methods are
usually implemented in a table-driven fashion, which is not suitable to write
by hand. As our grammar is simple enough and its input is not expected to be
large, the performance wouldn't be a problem. Thus, I choose to write the parser
in the most natural form--- a (predictive) recursive descent parser. The major benefit of a
recursive descent parser is **simplity** for the structure of resulting program
closely mirrors that of the grammar.

TODO:
    * comment
    * fonts: \bf, \textbf{} ...
    * size: \large, ...
    * noend
    * line number every k lines: \begin{algorithmic}[k]
    * caption without the number: \caption*{}
    * rename: e.g. require --> input, ensure --> output
    * elimiate the default space (smaller than a ' ' char) between spans
    * double quotes
*/

(function(parentModule, katex) { // rely on KaTex to process TeX math

// ===========================================================================
//  Utility functions
// ===========================================================================

function isString(str) {
    return (typeof str === 'string') || (str instanceof String);
}

function isObject(obj) {
    return (typeof obj === 'object' && (obj instanceof Object));
}

function toString(obj) {
    if (!isObject(obj)) return obj + '';

    var parts = [];
    for (var member in obj)
        parts.push(member + ': ' + toString(obj[member]));
    return parts.join(', ');
}

// ===========================================================================
//  Error handling
// ===========================================================================

function ParseError(message, pos, input) {
    var error = 'Error: ' + message;
    // If we have the input and a position, make the error a bit fancier
    if (pos !== undefined && input !== undefined) {
        error += " at position " + pos + ": `";

        // Insert a combining underscore at the correct position
        input = input.slice(0, pos) + "\u21B1" + input.slice(pos);

        // Extract some context from the input and add it to the error
        var begin = Math.max(0, pos - 15);
        var end = pos + 15;
        error += input.slice(begin, end) + "`";
    }

    this.message = error;
};
ParseError.prototype = Object.create(Error.prototype);
ParseError.prototype.constructor = ParseError;

// ===========================================================================
//  Lexer
// ===========================================================================

/* Math pattern
    Math environtment like $ $ or \( \) cannot be matched using regular
    expression. This object simulates a regular expression*/
var mathPattern = {
    exec: function(str) {
        if (str.indexOf('$') != 0) return null;

        var pos = 1;
        var len = str.length;
        while (pos < len && ( str[pos] != '$' || str[pos - 1] == '\\' ) ) pos++;

        if (pos === len) return null;
        return [str.substring(0, pos + 1), str.substring(1, pos)];
    }
};
var symbolRegex = {
    // TODO: which is correct? func: /^\\(?:[a-zA-Z]+|.)/,
    special: /^(\\\\|\\{|\\}|\\\$|\\&|\\#|\\%|\\_)/,
    func: /^\\([a-zA-Z]+)/,
    open: /^\{/,
    close: /^\}/,
    ordinary: /^[^\\{}$&#%_]+/,
    math: mathPattern ///^\$.*\$/
};
var whitespaceRegex = /^\s*/;

var Lexer = function(input) {
    this._input = input;
    this._remain = input;
    this._pos = 0;
    this._symbol = { type: null, text: null };
    this._lastText = null;
    this.next();
};

Lexer.prototype.accept = function(type, text) {
    if (this._symbol.type === type && this._matchText(text)) {
        var text = this._lastText = this._symbol.text;
        this.next();
        return text;
    }
    return false;
};

Lexer.prototype.expect = function(type, text) {
    var symbol = this._symbol;
    // The symbol is NOT of the right type
    if (symbol.type !== type)
        throw new ParseError('Expect a symbol of ' + type + ' but received ' +
            symbol.type, this._pos, this._input);
    // Check whether the text is exactly the same
    if (!this._matchText(text))
            throw new ParseError('Expect `' + text + '` but received `' + symbol.text + '`', this._pos, this._input);

    var text =this._lastText = this._symbol.text;
    this.next();
    return text;
};

Lexer.prototype.text = function() {
    return this._lastText;
};

/* Get the next symbol */
Lexer.prototype.next = function() {
    // Skip whitespace (zero or more)
    var whitespaceLen = whitespaceRegex.exec(this._remain)[0].length;
    this._pos += whitespaceLen;
    this._remain = this._remain.slice(whitespaceLen);

    var symbol = this._symbol;

    // Reach the end of string
    if (this._remain === '') {
        symbol.type = 'EOF';
        symbol.text = null;
        return null;
    }

    // Try all kinds of symbols
    for (var type in symbolRegex) {
        var regex = symbolRegex[type];

        var match = regex.exec(this._remain);
        if (!match) continue; // not matched

        // match[1] is the useful part, e.g. '123' of '$123$', 'it' of '\\it'
        var matchText = match[0];
        var usefulText = match[1] ? match[1] : matchText;

        this._symbol.type = type;
        this._symbol.text = usefulText;

        this._pos += matchText.length;
        this._remain = this._remain.slice(match[0].length);

        return true;
    }

    throw new ParseError('Unrecoganizable symbol',
            this._pos, this._input);
};

/* Check whether the text of the next symbol matches */
Lexer.prototype._matchText = function(text) {
    // don't need to match
    if (text === undefined) return true;

    if (isString(text)) // is a string, exactly the same?
        return text === this._symbol.text;
    else // is a list, match any of them?
        return text.indexOf(this._symbol.text) >= 0;
};

// ===========================================================================
//  Parser
// ===========================================================================

var ParseNode = function(type, val) {
    this.type = type;
    this.value = val;
    this.children = [];
};

ParseNode.prototype.toString = function(level) {
    if (!level) level = 0;

    var indent = '';
    for (var i = 0; i < level; i++) indent += '  ';

    var res = indent + '<' + this.type + '>';
    if (this.value) res += ' (' + toString(this.value) + ')';
    res += '\n';

    for (var ci = 0; ci < this.children.length; ci++) {
        var child = this.children[ci];
        res += child.toString(level + 1);
    }

    return res;
}

ParseNode.prototype.addChild = function(childNode) {
    if (!childNode) throw 'argument cannot be null';
    this.children.push(childNode);
};

var Parser = function(lexer) {
    this._lexer = lexer;
};

Parser.prototype.parse = function() {
    var root = new ParseNode('root');

    while (true) {
        var envName = this._acceptEnvironment();
        if (envName === null) break;

        var envNode;
        if (envName === 'algorithm')
            envNode = this._parseAlgorithmInner();
        else if (envName === 'algorithmic')
            envNode = this._parseAlgorithmicInner();
        else
            throw new ParseError('Unexpected environment ' + envName);

        this._closeEnvironment(envName);
        root.addChild(envNode);
    }
    this._lexer.expect('EOF');
    return root;
};

Parser.prototype._acceptEnvironment = function() {
    var lexer = this._lexer;
    // \begin{XXXXX}
    if (!lexer.accept('func', 'begin')) return null;

    lexer.expect('open');
    var envName = lexer.expect('ordinary');
    lexer.expect('close');
    return envName;
}

Parser.prototype._closeEnvironment = function(envName) {
    // \close{XXXXX}
    var lexer = this._lexer;
    lexer.expect('func', 'end');
    lexer.expect('open');
    lexer.expect('ordinary', envName);
    lexer.expect('close');
}

Parser.prototype._parseAlgorithmInner = function() {
    var algNode = new ParseNode('algorithm');
    while (true) {
        var envName = this._acceptEnvironment();
        if (envName !== null) {
            if (envName !== 'algorithmic')
                throw new ParseError('Unexpected environment ' + envName);
            var algmicNode = this._parseAlgorithmicInner();
            this._closeEnvironment();
            algNode.addChild(algmicNode);
            continue;
        }

        var captionNode = this._parseCaption();
        if (captionNode) {
            algNode.addChild(captionNode);
            continue;
        }

        break;
    }
    return algNode;
}

Parser.prototype._parseAlgorithmicInner = function() {
    var algmicNode = new ParseNode('algorithmic');
    while (true) {
        var node;
        if (!(node = this._parseCommand(CONDITION_COMMANDS)) &&
            !(node = this._parseBlock())) break;

        algmicNode.addChild(node);
    }
    return algmicNode;
};

Parser.prototype._parseCaption = function() {
    var lexer = this._lexer;
    if (!lexer.accept('func', 'caption')) return null;

    var captionNode = new ParseNode('caption');
    lexer.expect('open');
    captionNode.addChild(this._parseCloseText());
    lexer.expect('close');

    return captionNode;
}

Parser.prototype._parseBlock = function() {
    var blockNode = new ParseNode('block');

    while (true) {
        var controlNode = this._parseControl();
        if (controlNode) { blockNode.addChild(controlNode); continue; }

        var functionNode = this._parseFunction();
        if (functionNode) { blockNode.addChild(functionNode); continue; }

        var commandNode = this._parseCommand(STATEMENT_COMMANDS);
        if (commandNode) { blockNode.addChild(commandNode); continue; }

        var commentNode = this._parseComment();
        if (commentNode) { blockNode.addChild(commentNode); continue; }

        var callNode = this._parseCall();
        if (callNode) { blockNode.addChild(callNode); continue; }

        break;
    }

    return blockNode.children.length > 0 ? blockNode : null;
};

Parser.prototype._parseControl = function() {
    var controlNode;
    if ((controlNode = this._parseIf())) return controlNode;
    if ((controlNode = this._parseLoop())) return controlNode;
};

Parser.prototype._parseFunction = function() {
    var lexer = this._lexer;
    if (!lexer.accept('func', ['FUNCTION', 'PROCEDURE'])) return null;

    // \FUNCTION{funcName}{funcArgs}
    var funcType = this._lexer.text(); // FUNCTION or PROCEDURE
    lexer.expect('open');
    var funcName = lexer.expect('ordinary');
    lexer.expect('close');
    lexer.expect('open');
    var argsNode = this._parseCloseText();
    lexer.expect('close');
    // <block>
    var blockNode = this._parseBlock();
    // \ENDFUNCTION
    lexer.expect('func', 'END' + funcType);

    var functionNode = new ParseNode('function',
                        {type: funcType, name: funcName});
    functionNode.addChild(argsNode);
    functionNode.addChild(blockNode);
    return functionNode;
}

Parser.prototype._parseIf = function() {
    if (!this._lexer.accept('func', 'IF')) return null;

    var ifNode = new ParseNode('if');

    // { <cond> } <block>
    this._lexer.expect('open');
    ifNode.addChild(this._parseCond());
    this._lexer.expect('close');
    ifNode.addChild(this._parseBlock());

    // ( \ELIF { <cond> } <block> )[0...n]
    var numElif = 0;
    while (this._lexer.accept('func', 'ELIF')) {
        this._lexer.expect('open');
        elifsNode.addChild(this._parseCond());
        this._lexer.expect('close');
        elifsNode.addChild(this._parseBlock());
        numElif++;
    }

    // ( \ELSE <block> )[0..1]
    var hasElse = false;
    if (this._lexer.accept('func', 'ELSE')) {
        hasElse = true;
        ifNode.addChild(this._parseBlock());
    }

    // \ENDIF
    this._lexer.expect('func', 'ENDIF');

    ifNode.value = {numElif: numElif, hasElse: hasElse};
    return ifNode;
};

Parser.prototype._parseLoop = function() {
    if (!this._lexer.accept('func', ['FOR', 'WHILE'])) return null;

    var loopName = this._lexer.text();
    var loopNode = new ParseNode('loop', loopName);

    // { <cond> } <block>
    this._lexer.expect('open');
    loopNode.addChild(this._parseCond());
    this._lexer.expect('close');
    loopNode.addChild(this._parseBlock());

    // \ENDFOR
    this._lexer.expect('func', 'END' + loopName);

    return loopNode;
};

var CONDITION_COMMANDS = ['ENSURE', 'REQUIRE'];
var STATEMENT_COMMANDS = ['STATE', 'PRINT', 'RETURN'];
Parser.prototype._parseCommand = function(acceptCommands) {
    if (!this._lexer.accept('func', acceptCommands))
        return null;

    var cmdName = this._lexer.text();
    var cmdNode = new ParseNode('command', cmdName);
    cmdNode.addChild(this._parseOpenText());
    return cmdNode;
};

Parser.prototype._parseComment = function() {
    if (this._lexer.text() !== 'COMMENT') return null;

    var commentNode = new ParseNode('comment');

    // { \text }
    this._lexer.expect('open');
    commentNode.addChild(this._parseCloseText());
    this._lexer.expect('close');

    return commentNode;
};

Parser.prototype._parseCall = function() {
    var lexer = this._lexer;
    if (!lexer.accept('func', 'CALL')) return null;

    // \CALL { <ordinary> } { <text> }
    lexer.expect('open');
    var funcName = lexer.expect('ordinary');
    lexer.expect('close');
    lexer.expect('open');
    var argsNode = this._parseOpenText();
    lexer.expect('close');

    var callNode = new ParseNode('call');
    callNode.value = funcName;
    callNode.addChild(argsNode);
    return callNode;
};

Parser.prototype._parseCond =
Parser.prototype._parseCloseText = function() {
    return this._parseText('close');
};
Parser.prototype._parseOpenText = function() {
    return this._parseText('open');
};

Parser.prototype._parseText = function(openOrClose) {
    var textNode = new ParseNode(openOrClose + '-text');

    var symbolNode;
    while (true) {
        symbolNode = this._parseSymbol();
        if (symbolNode) {
            textNode.addChild(symbolNode);
            continue;
        }

        if (this._lexer.accept('open')) {
            var subTextNode = this._parseCloseText();
            textNode.addChild(subTextNode);
            this._lexer.expect('close');
            continue;
        }

        break;
    }

    return textNode;
};

Parser.prototype._parseSymbol = function() {
    var symbol;

    var text;
    if (text = this._lexer.accept('ordinary')) {
        return new ParseNode('ordinary', text);
    }
    else if (text = this._lexer.accept('math')) {
        return new ParseNode('math', text);
    }
    else if (text = this._lexer.accept('special')) {
        return new ParseNode('special', text);
    }
    else if (text = this._lexer.accept('func',
        ['AND', 'OR', 'NOT', 'TRUE', 'FALSE'])) {
        return new ParseNode('bool', text);
    }
    else if (text = this._lexer.accept('func',
        ['tiny', 'scriptsize', 'footnotesize', 'small', 'normalsize',
        'large', 'Large', 'LARGE', 'huge', 'Huge'])) {
        return new ParseNode('sizing-dclr', text);
    }
    else if (text = this._lexer.accept('func',
        ['rmfamily', 'sffamily', 'ttfamily',
         'upshape', 'itshape', 'slshape', 'scshape',
         'bfseries', 'mdseries', 'lfseries',
         'uppercase', 'lowercase'])) {
        return new ParseNode('font-dclr', text);
    }
    return null;
}

// ===========================================================================
//  Builder - Maps a ParseTree to its HTML couterpart
//      The builder make use of KaTeX to render mathematical expressions.
// ===========================================================================

function BuilderOptions(options) {
    options = options || {};
    this.indentSize = options.indentSize ?
                        this._parseEmVal(options.indentSize) : 1.2;
    this.commentSymbol = options.commentSymbol || '//';
    this.lineNumberPunc = options.lineNumberPunc || ':';
    this.lineNumber = options.lineNumber != null ? options.lineNumber : false;
}

BuilderOptions.prototype._parseEmVal = function(emVal) {
    var emVal = emVal.trim();
    if (emVal.indexOf('em') !== emVal.length - 2)
        throw 'Option unit error; no `em` found';
    return Number(emVal.substring(0, emVal.length - 2));
}

/*
   The font information used by builder to render the ouput HTML

   options - set attributes of font, null value means default
        family - roman, sans serif, teletype
        size - ..., small, normalsize, large, Large, ...
        weight - normal, bold
        color -
        variant - none, small-caps
*/
function TextStyle(outerTextStyle) {
    this._css = {};
    this._fontSize = 1.0;
    this._outerFontSize = outerTextStyle ? outerTextStyle.fontSize() : 1.0;
}

/* Update the font state by TeX command
    cmd - the name of TeX command that alters current font
*/
TextStyle.prototype._fontCommandTable = {
    // font-family
    rmfamily: { 'font-family': 'KaTeX_Main' },
    sffamily: { 'font-family': 'KaTeX_SansSerif'},
    ttfamily: { 'font-family': 'KaTeX_Typewriter'},
    // weight
    bfseries: { 'font-weight': 'bold'},
    mdseries: { 'font-weight': 'medium'},
    lfseries: { 'font-weight': 'lighter'},
    // shape
    upshape: { 'font-style': 'normal', 'font-variant': 'normal'},
    itshape: { 'font-style': 'italic', 'font-variant': 'normal'},
    scshape: { 'font-style': 'normal', 'font-variant': 'small-caps'},
    slshape: { 'font-style': 'oblique', 'font-variant': 'normal'},
    // case
    uppercase: { 'text-transform': 'uppercase'},
    lowercase: { 'text-transform': 'lowercase'}
};

TextStyle.prototype._sizingScalesTable = {
    tiny:           0.68,
    scriptsize:     0.80,
    footnotesize:   0.85,
    small:          0.92,
    normalsize:     1.00,
    large:          1.17,
    Large:          1.41,
    LARGE:          1.58,
    huge:           1.90,
    Huge:           2.28
};

TextStyle.prototype.fontSize = function() {
    return this._fontSize;
}

TextStyle.prototype.updateByCommand = function(cmd) {
    // Font command
    var cmdStyles = this._fontCommandTable[cmd];
    if (cmdStyles !== undefined) {
        for (var attr in cmdStyles)
            this._css[attr] = cmdStyles[attr];
        return;
    }

    // Sizing command
    var fontSize = this._sizingScalesTable[cmd];
    if (fontSize !== undefined) {
        var scale = fontSize / this._outerFontSize;
        this._css['font-size'] = scale + 'em';
        this._fontSize = this._outerFontSize = fontSize;
        return;
    }

    throw new ParserError('unrecogniazed text-style command');
};

TextStyle.prototype.toCSS = function() {
    var cssStr = '';
    for (var attr in this._css) {
        var val = this._css[attr];
        if (val == null) continue;
        cssStr += attr + ':' + this._css[attr] + ';';
    }
    return cssStr;
};

function TextEnvironment(nodes, open, outerTextStyle) {
    this._nodes = nodes;
    this._outerTextStyle = outerTextStyle;

    // For an close text environment, text-style changes should only take
    // effect inside the environment. Thus, we should NOT modify
    // `outerTextStyle`. In contrast, for an open text environment, we make all
    // the updates on outerTextStyle directly.
    this._textStyle = open ? outerTextStyle : new TextStyle(outerTextStyle);
}

TextEnvironment.prototype.renderToHTML = function() {
    this._html = new HTMLBuilder();

    var node;
    while (node = this._nodes.shift()) {
        switch(node.type) {
        case 'ordinary':
            var text = node.value;
            this._html.putText(text);
            break;
        case 'math':
            var math = node.value;
            var mathHTML = katex.renderToString(math);
            this._html.putSpan(mathHTML);
            break;
        case 'special':
            var escapedStr = node.value;
            var replace = {
                '\\\\': '<br/>',
                '\\{': '{',
                '\\}': '}',
                '\\$': '$',
                '\\&': '&',
                '\\#': '#',
                '\\%': '%',
                '\\_': '_'
            };
            var replaceStr = replace[escapedStr];
            this._html.putText(replaceStr);
            break;
        case 'close-text':
            var textEnv = new TextEnvironment(node.children, false, this._textStyle);
            this._html.putSpan(textEnv.renderToHTML());
            break;
        // There are two kinds of typestyle commands:
        //      command (e.g. \textrm{...}).
        // and
        //      declaration (e.g. { ... \rmfamily ... })
        //
        // For typestyle commands, it works as following:
        //      \textsf     --> create a new typestyle
        //      {           --> save the current typestyle, and then use the new one
        //      ...         --> the new typestyle is in use
        //      }           --> restore the last typestyle
        //
        // For typestyle declaration, it works a little bit diferrently:
        //      {           --> save the current typestyle, and then create and use
        //                      an identical one
        //      ...         --> the new typestyle is in use
        //      \rmfamily   --> create a new typestyle
        //      ...         --> the new typestyle is in use
        //      }           --> restore the last typestyle
        case 'font-dclr':
        case 'sizing-dclr':
            var cmdName = node.value;
            this._textStyle.updateByCommand(cmdName);
            this._html.beginSpan(null, this._textStyle.toCSS());
            var textEnv = new TextEnvironment(this._nodes, true, this._textStyle);
            this._html.putSpan(textEnv.renderToHTML());
            this._html.endSpan();
            break;
        default:
            throw new ParseError('Unexpected ParseNode of type ' + node.type);
        }
    }

    return this._html.toMarkup();
};

/* HTMLBuilder - A helper class for constructing HTML */
function HTMLBuilder() {
    this._body = [];
    this._textBuf = [];
}

HTMLBuilder.prototype.beginDiv = function(className, style, extraStyle) {
    return this._beginTag('div', className, style, extraStyle);
};

HTMLBuilder.prototype.endDiv = function() {
    return this._endTag('div');
};

HTMLBuilder.prototype.beginP = function(className, style, extraStyle) {
    return this._beginTag('p', className, style, extraStyle);
};

HTMLBuilder.prototype.endP = function() {
    this._flushText();
    return this._endTag('p');
};

HTMLBuilder.prototype.beginSpan = function(className, style, extraStyle) {
    this._flushText();
    return this._beginTag('span', className, style, extraStyle);
};

HTMLBuilder.prototype.endSpan = function() {
    this._flushText();
    return this._endTag('span');
}

HTMLBuilder.prototype.putSpan = function(spanHTML) {
    this._flushText();
    this._body.push(spanHTML);
    return this;
}

HTMLBuilder.prototype.putText = function(text) {
    this._textBuf.push(text);
    return this;
}

HTMLBuilder.prototype.write = function(html) {
    this._body.push(html);
}

HTMLBuilder.prototype.toMarkup = function() {
    this._flushText();
    var html = this._body.join('\n');
    return html;
}

HTMLBuilder.prototype.toDOM = function() {
    var html = this.toMarkup();
    var div = document.createElement('div');
    div.innerHTML = html;
    return div.firstChild;
}

HTMLBuilder.prototype._flushText = function(text) {
    if (this._textBuf.length == 0) return;

    var text = this._textBuf.join('');
    this._body.push(text);
    this._textBuf = [];
}

/* Write the beginning of a DOM element
    tag - the tag of the element
    className - the className for the tag
    style - CSS style that applies directly on the tag. This parameter can be
            either a string, e.g., 'color:red', or an object, e.g.
            { color: 'red', margin-left: '1em'}
*/
HTMLBuilder.prototype._beginTag = function(tag, className, style, extraStyle) {
    var spanHTML = '<' + tag;
    if (className) spanHTML += ' class="' + className + '"';
    if (style) {
        var styleCode;
        if (isString(style)) styleCode = style;
        else { // style
            styleCode = '';
            for (var attrName in style) {
                attrVal = style[attrName];
                styleCode += attrName + ':' + attrVal + ';';
            }
        }
        if (extraStyle) styleCode += extraStyle;
        spanHTML += ' style="' + styleCode + '"';
    }
    spanHTML += '>';
    this._body.push(spanHTML);
    return this;
}

HTMLBuilder.prototype._endTag = function(tag) {
    this._body.push('</' + tag + '>');
    return this;
}

/*
    The renderer converts a parse tree to HTML.

    There are three levels in renderer:
        Group (Block), Line and Segment,
    which are rendered to HTML tag, <div>, <p>, and <span>, respectively.

*/
function Renderer(parser, options) {
    this._root = parser.parse();
    // debug
    console.log(this._root.toString());
    this._options = new BuilderOptions(options);
    this._openLine = false;
    this._blockLevel = 0;
    this._textLevel = -1;
    this._globalTextStyle = new TextStyle();
}

/*  The global counter for the numbering of the algorithm environment */
Renderer.prototype._captionCount = 0;

Renderer.prototype.toMarkup = function() {
    var html = this._html = new HTMLBuilder();
    this._buildTree(this._root);
    delete this._html;
    return html.toMarkup();
}

Renderer.prototype.toDOM = function() {
    var html = this.toMarkup();
    var div = document.createElement('div');
    div.innerHTML = html;
    return div.firstChild;
}

Renderer.prototype._beginGroup = function(name, extraClass, style) {
    this._closeLineIfAny();
    this._html.beginDiv('ps-' + name + (extraClass ? ' ' + extraClass : ''),
                        style);
}

Renderer.prototype._endGroup = function(name) {
    this._closeLineIfAny();
    this._html.endDiv();
}

Renderer.prototype._beginBlock = function() {
    // The first block have to extra left margin when line number are displayed
    var extraIndentForFirstBlock =
        this._options.lineNumber && this._blockLevel == 0 ? 0.6 : 0;
    var blockIndent = this._options.indentSize + extraIndentForFirstBlock;

    this._beginGroup('block', null, {
        'margin-left': blockIndent + 'em'
    });
    this._blockLevel++;
}

Renderer.prototype._endBlock = function() {
    this._closeLineIfAny();
    this._endGroup();
    this._blockLevel--;
}

Renderer.prototype._newLine = function() {
    this._closeLineIfAny();

    this._openLine = true;

    var indentSize = this._options.indentSize;
    // if this line is for code (e.g. \STATE)
    if (this._blockLevel > 0) {
        this._numLOC++;

        this._html.beginP('ps-line ps-code', this._globalTextStyle.toCSS());
        if (this._options.lineNumber) {
            this._html.beginSpan('ps-linenum', {
                'left': - ((this._blockLevel - 1)*(indentSize - 0.2)) + 'em'
            })
            .putText(this._numLOC + this._options.lineNumberPunc)
            .endSpan();
        }
    }
    // if this line is for pre-conditions (e.g. \REQUIRE)
    else {
        this._html.beginP('ps-line', {
            'text-indent': (-indentSize) + 'em',
            'padding-left': indentSize + 'em'
        }, this._globalTextStyle.toCSS());
    }
}

Renderer.prototype._closeLineIfAny = function() {
    if (!this._openLine) return;

    this._html.endP();

    this._openLine = false;
}

Renderer.prototype._typeKeyword = function(keyword) {
    this._html.beginSpan('ps-keyword').putText(keyword).endSpan();
}

Renderer.prototype._typeFuncName = function(funcName) {
    this._html.beginSpan('ps-funcname').putText(funcName).endSpan();
}

Renderer.prototype._typeText = function(text) {
    this._html.write(text);
}

Renderer.prototype._buildTreeForAllChildren = function(node) {
    var children = node.children;
    for (var ci = 0; ci < children.length; ci++)
        this._buildTree(children[ci]);
}

Renderer.prototype._buildTree = function(node) {
    switch(node.type) {
    // The hierarchicy of build tree: Group (Block) > Line > Text
    // ----------------- Groups -------------------------------------
    case 'root':
        this._beginGroup('root');
        this._buildTreeForAllChildren(node);
        this._endGroup();
        break;
    case 'algorithm':
        // First, decide the caption if any
        var lastCaptionNode;
        for (var ci = 0; ci < node.children.length; ci++) {
            var child = node.children[ci];
            if (child.type !== 'caption') continue;
            lastCaptionNode = child;
            this._captionCount++;
        }
        // Then, build the header for algorithm
        if (lastCaptionNode) {
            this._beginGroup('algorithm', 'with-caption');
            this._buildTree(lastCaptionNode);
        }
        else {
            this._beginGroup('algorithm');
        }
        // Then, build other nodes
        for (var ci = 0; ci < node.children.length; ci++) {
            var child = node.children[ci];
            if (child.type === 'caption') continue;
            this._buildTree(child);
        }
        this._endGroup();
        break;
    case 'algorithmic':
        if (this._options.lineNumber) {
            this._beginGroup('algorithmic', 'with-linenum');
            this._numLOC = 0;
        }
        else {
            this._beginGroup('algorithmic');
        }
        this._buildTreeForAllChildren(node);
        this._endGroup();
        break;
    case 'block':
        // node: <block>
        // ==>
        // HTML: <div class="ps-block"> ... </div>
        this._beginBlock();
        this._buildTreeForAllChildren(node);
        this._endBlock();
        break;
    // ----------------- Mixture (Groups + Lines) -------------------
    case 'function':
        // \FUNCTION{<ordinary>}{<text>} <block> \ENDFUNCTION
        // ==>
        // function <ordinary>(<text>)
        // ...
        // end function
        var funcType = node.value.type.toLowerCase();
        var funcName = node.value.name;
        var textNode = node.children[0];
        var blockNode = node.children[1];
        this._newLine();
        this._typeKeyword(funcType);
        this._typeFuncName(funcName);
        this._typeText('(');
        this._buildTree(textNode);
        this._typeText(')');

        this._buildTree(blockNode);

        this._newLine();
        this._typeKeyword('end ' + funcType);
        break;
    case 'if':
        // \IF { <cond> }
        // ==>
        // <p class="ps-line">
        //      <span class="ps-keyword">if</span>
        //      ...
        //      <span class="ps-keyword">then</span>
        // </p>
        this._newLine();
        this._typeKeyword('if');
        var cond = node.children[0];
        this._buildTree(cond);
        this._typeKeyword('then');
        // <block>
        var ifBlock = node.children[1];
        this._buildTree(ifBlock);

        // ( \ELIF {<cond>} <block> )[0..n]
        var numElif = node.value.numElif;
        for (var ei = 0 ; ei < numElif; ei++) {
            // \ELIF {<cond>}
            // ==>
            // <p class="ps-line">
            //      <span class="ps-keyword">elif</span>
            //      ...
            //      <span class="ps-keyword">then</span>
            // </p>
            this._newLine();
            this._typeKeyword('if');
            var elifCond = node.children[2 + 2 * ei];
            this._buildTree(elifCond);
            this._typeKeyword('then');

            // <block>
            var elifBlock = node.children[2 + 2 * ei + 1];
            this._buildTree(elifBlock);
        }

        // ( \ELSE <block> )[0..1]
        var hasElse = node.value.hasElse;
        if (hasElse) {
            // \ELSE
            // ==>
            // <p class="ps-line">
            //      <span class="ps-keyword">else</span>
            // </p>
            this._newLine();
            this._typeKeyword('else');

            // <block>
            var elseBlock = node.children[node.children.length - 1];
            this._buildTree(elseBlock);
        }

        // ENDIF
        this._newLine();
        this._typeKeyword('end if');
        break;
    case 'loop':
        // \FOR{<cond>} or \WHILE{<cond>}
        // ==>
        // <p class="ps-line">
        //      <span class="ps-keyword">for</span>
        //      ...
        //      <span class="ps-keyword">do</span>
        // </p>
        var loopName = node.value.toLowerCase();
        this._newLine();
        this._typeKeyword(loopName);
        var cond = node.children[0];
        this._buildTree(cond);
        this._typeKeyword('do');

        // <block>
        var block = node.children[1];
        this._buildTree(block);

        // \ENDFOR or \ENDWHILE
        // ==>
        // <p class="ps-line">
        //      <span class="ps-keyword">end for</span>
        // </p>
        this._newLine();
        this._typeKeyword('end ' + loopName);
        break;
    // ------------------- Lines -------------------
    case 'command':
        // commands: \STATE, \ENSURE, \PRINT, \RETURN, etc.
        var cmdName = node.value;
        var displayName = {
            'STATE': '',
            'ENSURE': 'Ensure:',
            'REQUIRE': 'Require:',
            'PRINT': 'print',
            'RETURN': 'return'
        }[cmdName];

        this._newLine();
        if (displayName) this._typeKeyword(displayName);
        var text = node.children[0];
        this._buildTree(text);
        break;
    case 'caption':
        this._newLine();
        this._typeKeyword('Algorithm ' + this._captionCount);
        var textNode = node.children[0];
        this._buildTree(textNode);
        break;
    // 'comment':
    //     break;
    case 'call':
        // \CALL{funcName}{funcArgs}
        // ==>
        // funcName(funcArgs)
        var funcName = node.value;
        var argsNode = node.children[0];
        this._typeFuncName(funcName);
        this._typeText('(');
        this._buildTree(argsNode);
        this._typeText(')');
        break;
    // ------------------- Text -------------------
    case 'open-text':
        var textEnv = new TextEnvironment(node.children, true, this._globalTextStyle);
        this._html.putSpan(textEnv.renderToHTML());
        break;
    case 'close-text':
        var textEnv = new TextEnvironment(node.children, false, this._globalTextStyle);
        this._html.putSpan(textEnv.renderToHTML());
        break;
    default:
        throw new ParseError('Unexpected ParseNode of type ' + node.type);
    }
}

// ===========================================================================
//  Entry points
// ===========================================================================
parentModule.PseudoCode = {
    renderToString: function(input, options) {
        if (input == null) throw 'input cannot be empty';

        var lexer = new Lexer(input);
        var parser = new Parser(lexer);
        var renderer = new Renderer(parser, options);
        return renderer.toMarkup();
    },
    render: function(input, baseDomEle, options) {
        if (input == null || baseDomEle == null) throw 'argument cannot be null';

        var lexer = new Lexer(input);
        var parser = new Parser(lexer);
        var renderer = new Renderer(parser, options);
        var ele = renderer.toDOM();
        baseDomEle.appendChild(ele);
        return ele;
    }
};

})(window, katex);
