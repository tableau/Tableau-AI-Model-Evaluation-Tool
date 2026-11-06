/* Calculation grammar based on work by Dan Cory. */
grammar TableauCalculationGrammar;

// ( [ \t\r\n]+ | [ \t]* ('//' ~[\r\n]* ('\r\n' | '\r' | '\n' | EOF)) )+;
wss: (WSS | LINECOMMENT? EOL | BLOCKCOMMENT )+;
EOL : '\r\n' | '\r' | '\n';
WSS : [ \t\r\n]+ -> skip ;  // Skip whitespace
LINECOMMENT : '//' ~[\r\n]* -> skip ;  // Skip single-line comments
BLOCKCOMMENT: '/*' .*? '*/' -> skip ;  // Skip block comments

// symbols
DIV : '/';
EQ : '=' | '==';
GEQ : '>=';
GT : '>';
LEQ : '<=';
LPAREN : '(';
LT : '<';
MINUS : '-';
MULT : '*';
NEQ : '<>' | '!=';
PLUS : '+';
RPAREN : ')';
L_SQUARE_BRACKET : '[';
R_SQUARE_BRACKET : ']';
L_BRACE : '{';
R_BRACE : '}';
MOD : '%';
COMMA : ',';
POW : '^';
COLON : ':';

calculation: valueStmt LINECOMMENT? EOF;

// operator precedence is represented by rule order
valueStmt :
      wss? literal wss?                                                                                                 # vsLiteral
    | wss? field wss?                                                                                                   # vsField
    | wss? LPAREN wss? valueStmt wss? RPAREN wss?                                                                       # vsParen
    | wss? functionName=MINUS valueStmt wss?                                                                            # vsUnaryFunction
    | valueStmt wss? functionName=POW wss? valueStmt                                                                    # vsPowerFunction
    | valueStmt wss? functionName=( MOD | DIV | MULT ) wss? valueStmt                                                   # vsMultiplicativeFunction
    | valueStmt wss? functionName=( PLUS | MINUS ) wss? valueStmt                                                       # vsAdditiveFunction
    | valueStmt wss? functionName=( GEQ | LEQ | GT | LT | NEQ | EQ ) wss? valueStmt                                     # vsComparisonFunction
    | wss? functionName=NOT valueStmt                                                                                   # vsNegationFunction
    | valueStmt wss? functionName=AND wss? valueStmt                                                                    # vsAndFunction
    | valueStmt wss? functionName=OR wss? valueStmt                                                                     # vsOrFunction
    | wss? functionName=IF valueStmt THEN valueStmt ( ELSEIF valueStmt THEN valueStmt )* ( ELSE valueStmt )? END wss?   # vsIfFunction
    | wss? CASE valueStmt whenClause+ ( ELSE valueStmt )? END wss?                                                      # vsCaseFunction
    | valueStmt functionName=IN inList                                                                                  # vsInList
    | valueStmt IN wss? field wss?                                                                                      # vsInSet
    | wss? L_BRACE (wss? functionName=LODSCOPE wss? lodDimensions? COLON)? valueStmt R_BRACE wss?                       # vsLOD
    | wss? functionName=AGGREGATE wss? LPAREN wss? ( valueStmt ( COMMA valueStmt )* )? RPAREN wss?                      # vsAggregateFunction
    | wss? functionName=AGGREGATEWITHSAMEARGUMENTS wss? LPAREN wss? valueStmt RPAREN wss?                               # vsAggregateWithSameArgumentsFunction
    | wss? functionName=AGGREGATECOUNT wss? LPAREN wss? valueStmt RPAREN wss?                                           # vsAggregateCountFunction
    | wss? functionName=NUMBERFUNC wss? LPAREN wss? valueStmt RPAREN wss?                                               # vsNumberFunction
    | wss? functionName=DATEFUNC wss? LPAREN wss? ( valueStmt ( COMMA valueStmt )* )? RPAREN wss?                       # vsDateFunction
    | wss? functionName=STRINGFUNC wss? LPAREN wss? ( valueStmt ( COMMA valueStmt )* )? RPAREN wss?                     # vsStringFunction
    | wss? functionName=LOGICALFUNC wss? LPAREN wss? valueStmt RPAREN wss?                                              # vsLogicalFunction
    | wss? functionName=IFNULL wss? LPAREN wss? valueStmt wss? COMMA wss? valueStmt wss? RPAREN wss?                    # vsIFNullFunction
    | wss? functionName=FUNCTIONORFIELD wss? LPAREN wss? ( valueStmt ( COMMA valueStmt )* )? RPAREN wss?                # vsGeneralFunction
    | wss? windowFunctionExpr                                                                                           # vsWindowFunctionExpr
    | wss? partitionExprWithOrder                                                                                       # vsPartitionWithOrder
    | wss? orderByExpr                                                                                                  # vsOrderExpr
    ;

windowFunctionExpr
    : functionName=FUNCTIONORFIELD wss? LPAREN wss? ( valueStmt ( COMMA valueStmt )* )? RPAREN partitionByExpr?
    ;

partitionByExpr
    : wss? PARTITION wss? BY wss? field
    ;

partitionExprWithOrder
    : wss? L_BRACE wss? PARTITION wss? field wss? COLON wss? orderByExpr wss? R_BRACE
    ;

orderByExpr
    : L_BRACE wss? ORDERBY wss? field wss? (ASC | DESC)? wss? COLON wss? windowFunctionExpr wss? R_BRACE
    ;

whenClause: WHEN valueStmt THEN valueStmt;

lodDimensions: valueStmt ( COMMA valueStmt )*;

inList: wss? LPAREN ( valueStmt COMMA )* wss? valueStmt? RPAREN wss?;


field: FIELDNAME | FUNCTIONORFIELD | SECONDARYFIELDNAME | SECONDARYOBJECTNAME;
FIELDNAME: BRACKETNAME;
SECONDARYFIELDNAME: BRACKETNAME '.' BRACKETNAME;
SECONDARYOBJECTNAME: BRACKETNAME '.' BRACKETNAME '.' BRACKETNAME;

literal: DATELITERAL | DOUBLELITERAL | INTEGERLITERAL | STRINGLITERAL | BOOLEANLITERAL | NULL;

LODSCOPE: FIXED | INCLUDE | EXCLUDE;

BRACKETNAME: L_SQUARE_BRACKET (~[\]] | '\\' | R_SQUARE_BRACKET R_SQUARE_BRACKET)* R_SQUARE_BRACKET;

STRINGLITERAL: ('"' (~["] | '""')* '"') | ('\'' (~['] | '\'\'')* '\'');

DATELITERAL: '#' (~[#\r\n])* '#';

INTEGERLITERAL: DIGIT+;
DOUBLELITERAL: ( DIGIT+ '.' DIGIT* SCIENTIFIC? ) | ( DIGIT* '.' DIGIT+ SCIENTIFIC? ) | ( DIGIT+ SCIENTIFIC );

BOOLEANLITERAL: TRUE | FALSE;

AGGREGATE:  MIN | MAX;
AGGREGATEWITHSAMEARGUMENTS: SUM | AVG;
AGGREGATECOUNT: COUNT | COUNTD;
NUMBERFUNC: ABS | CEIL | FLOOR | ROUND | ZN | INT | RAND | LN | LOG | EXP;
DATEFUNC: DATEADD | DATEPART | DATEDIFF | TODATE | MAKEDATE;
STRINGFUNC: LEN | LOWER | UPPER | REPLACE | SPLIT | LTRIM | RTRIM | TRIM | APPEND;
LOGICALFUNC: ISNULL | ISDATE | ISSTRING | ISNUMBER;

// keywords:
TRUE : T R U E;
FALSE : F A L S E;
NULL : N U L L;
END : E N D;
INCLUDE : I N C L U D E;
EXCLUDE : E X C L U D E;
FIXED : F I X E D;
IF : I F;
THEN : T H E N;
ELSE : E L S E;
CASE : C A S E;
WHEN : W H E N;
ELSEIF : E L S E I F;
AND : A N D;
OR : O R;
NOT : N O T;
IN : I N;
PARTITION : P A R T I T I O N;
BY : B Y;
ORDERBY: O R D E R B Y;
ASC: A S C;
DESC: D E S C;

// Define specific functions as keywords
SUM : S U M;
COUNT : C O U N T;
COUNTD : C O U N T D;
MIN : M I N;
MAX : M A X;
AVG : A V G;
ABS : A B S;
CEIL : C E I L;
FLOOR : F L O O R;
ROUND : R O U N D;
ZN : Z N;
INT : I N T;
RAND : R A N D;
LN : L N;
LOG : L O G;
EXP : E X P;
DATEDIFF : D A T E D I F F;
DATEPART : D A T E P A R T;
TO_DATE : T O D A T E;
TODATE: T O D A T E;
MAKEDATE : M A K E D A T E;
LEN : L E N;
LOWER : L O W E R;
UPPER : U P P E R;
REPLACE : R E P L A C E;
SPLIT : S P L I T;
LTRIM : L T R I M;
RTRIM : R T R I M;
TRIM : T R I M;
ISNULL : I S N U L L;
IFNULL : I F N U L L;
ISDATE : I S D A T E;
ISSTRING : I S S T R I N G;
ISNUMBER : I S N U M B E R;
DATEADD: D A T E A D D;
APPEND: A P P E N D;

FUNCTIONORFIELD: (LETTER | '_' ) (LETTER | '_' | ALLDIGIT)*;

fragment SCIENTIFIC: E (PLUS | MINUS)? DIGIT+;
fragment LETTER: [\p{L}];
fragment ALLDIGIT: [\p{Nd}];
fragment DIGIT: [0-9];

fragment A: ('a'|'A');
fragment B: ('b'|'B');
fragment C: ('c'|'C');
fragment D: ('d'|'D');
fragment E: ('e'|'E');
fragment F: ('f'|'F');
fragment G: ('g'|'G');
fragment H: ('h'|'H');
fragment I: ('i'|'I');
fragment J: ('j'|'J');
fragment K: ('k'|'K');
fragment L: ('l'|'L');
fragment M: ('m'|'M');
fragment N: ('n'|'N');
fragment O: ('o'|'O');
fragment P: ('p'|'P');
fragment Q: ('q'|'Q');
fragment R: ('r'|'R');
fragment S: ('s'|'S');
fragment T: ('t'|'T');
fragment U: ('u'|'U');
fragment V: ('v'|'V');
fragment W: ('w'|'W');
fragment X: ('x'|'X');
fragment Y: ('y'|'Y');
fragment Z: ('z'|'Z');
