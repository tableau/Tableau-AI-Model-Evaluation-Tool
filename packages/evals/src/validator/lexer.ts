/** Generated lexer, exposed through the stable token interface. */
import { BaseErrorListener, CharStream, Token as AntlrToken } from "antlr4ng";
import { TableauCalculationGrammarLexer } from "./generated/TableauCalculationGrammarLexer.ts";

export enum TokenType {
  FIELDNAME = "FIELDNAME", SECONDARYFIELDNAME = "SECONDARYFIELDNAME", SECONDARYOBJECTNAME = "SECONDARYOBJECTNAME",
  STRINGLITERAL = "STRINGLITERAL", DATELITERAL = "DATELITERAL", INTEGERLITERAL = "INTEGERLITERAL",
  DOUBLELITERAL = "DOUBLELITERAL", BOOLEANLITERAL = "BOOLEANLITERAL", NULL = "NULL", FUNCTIONORFIELD = "FUNCTIONORFIELD",
  DIV = "DIV", EQ = "EQ", GEQ = "GEQ", GT = "GT", LEQ = "LEQ", LPAREN = "LPAREN", LT = "LT",
  MINUS = "MINUS", MULT = "MULT", NEQ = "NEQ", PLUS = "PLUS", RPAREN = "RPAREN",
  L_SQUARE_BRACKET = "L_SQUARE_BRACKET", R_SQUARE_BRACKET = "R_SQUARE_BRACKET",
  L_BRACE = "L_BRACE", R_BRACE = "R_BRACE", MOD = "MOD", COMMA = "COMMA", POW = "POW", COLON = "COLON",
  LODSCOPE = "LODSCOPE", AGGREGATE = "AGGREGATE", AGGREGATEWITHSAMEARGUMENTS = "AGGREGATEWITHSAMEARGUMENTS",
  AGGREGATECOUNT = "AGGREGATECOUNT", NUMBERFUNC = "NUMBERFUNC", DATEFUNC = "DATEFUNC", STRINGFUNC = "STRINGFUNC", LOGICALFUNC = "LOGICALFUNC",
  END = "END", IF = "IF", THEN = "THEN", ELSE = "ELSE", CASE = "CASE", WHEN = "WHEN", ELSEIF = "ELSEIF",
  AND = "AND", OR = "OR", NOT = "NOT", IN = "IN", PARTITION = "PARTITION", BY = "BY", ORDERBY = "ORDERBY",
  ASC = "ASC", DESC = "DESC", IFNULL = "IFNULL", EOF = "EOF",
}

export interface Token {
  type: TokenType;
  text: string;
  /** 0-based Unicode code-point index, as in ANTLR. */
  start: number;
  /** 1-based line */
  line: number;
  /** 0-based column */
  column: number;
}

export class LexError extends Error {
  constructor(message: string, public line: number, public column: number) {
    super(message);
    this.name = "LexError";
  }
}

export function calculationLexer(input: string): TableauCalculationGrammarLexer {
  const lexer = new TableauCalculationGrammarLexer(CharStream.fromString(input));
  lexer.removeErrorListeners();
  const listener = new BaseErrorListener();
  listener.syntaxError = (_recognizer, _symbol, line, column, message) => {
    throw new LexError(message, line, column);
  };
  lexer.addErrorListener(listener);
  return lexer;
}

/** Includes EOF. Symbol names remain those of the checked-in grammar. */
export function tokenize(input: string): Token[] {
  const lexer = calculationLexer(input);
  const tokens: Token[] = [];
  for (;;) {
    const token = lexer.nextToken();
    const name = token.type === AntlrToken.EOF ? "EOF" : lexer.vocabulary.getSymbolicName(token.type)!;
    tokens.push({ type: name as TokenType, text: token.text ?? "", start: token.start, line: token.line, column: token.column });
    if (token.type === AntlrToken.EOF) return tokens;
  }
}
