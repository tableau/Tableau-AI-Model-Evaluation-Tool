grammar TableauExpression;

expressionEOF : expression EOF;

/*
Operator precedence and behavior for Tableau is defined here:
https://onlinehelp.tableau.com/current/pro/desktop/en-us/functions_operators.html
*/

expression
  : lodExpression
  | analyticsExpression
  | scalarExpression;

lodExpression
  : lodStatement
  | LPAREN lodExpression RPAREN
  | lodStatementIncomplete
  | lodStatementUnsupported
  | comment lodExpression
  | lodExpression comment
  | lodStatementNestedExpressions;

scalarExpression
  : comment scalarExpression                         #commentExpression
  | LPAREN scalarExpression RPAREN                   #groupingExpression
  | MINUS scalarExpression                           #negationExpression
  | scalarExpression EXPONENT scalarExpression       #exponentExpression
  | scalarExpression multDivOps scalarExpression     #multDivExpression
  | scalarExpression addSubOps scalarExpression      #addSubExpression
  | scalarExpression comparisonOps scalarExpression  #comparisonExpression
  | NOT scalarExpression                             #notExpression
  | scalarExpression AND scalarExpression            #andExpression
  | scalarExpression OR scalarExpression             #orExpression
  | ifStatement                                      #ifExpression
  | ifStatementIncomplete                            #ifExpressionIncomplete
  | caseStatement                                    #caseExpression
  | caseStatementIncomplete                          #caseExpressionIncomplete
  | fieldReference                                   #fieldExpression
  | fieldReferenceIncomplete                         #fieldExpressionIncomplete
  | functionCall                                     #functionExpression
  | functionCallIncomplete                           #functionExpressionIncomplete
  | literal                                          #literalExpression
  | literalIncomplete                                #literalExpressionIncomplete
  | scalarExpression comment                         #expressionComment
  | lodExpression                                    #lodStatementNotTopLevel
  ;

validAnalyticsExpression
  : orderbyExpression                                 
  | partitionExpression;

// 2023.2 -- Add/Sub/Multi/Div multiple analytical calculations.
multipleValidAnalyticsExpressions
  : validAnalyticsExpression addSubOps validAnalyticsExpression #addSubExpressionAnalytic
  | validAnalyticsExpression multDivOps validAnalyticsExpression #multDivExpressionAnalytic
  | multipleValidAnalyticsExpressions addSubOps validAnalyticsExpression #addSubExpressionAnalytic
  | multipleValidAnalyticsExpressions multDivOps validAnalyticsExpression #multDivExpressionAnalytic
  | multipleValidAnalyticsExpressions multDivOps floatLiteral #multDivExpressionAnalytic
  | multipleValidAnalyticsExpressions multDivOps integerLiteral #multDivExpressionAnalytic
  | LPAREN validAnalyticsExpression addSubOps validAnalyticsExpression RPAREN #addSubExpressionAnalytic
  | LPAREN validAnalyticsExpression multDivOps validAnalyticsExpression RPAREN #multDivExpressionAnalytic
  | LPAREN multipleValidAnalyticsExpressions addSubOps validAnalyticsExpression RPAREN #addSubExpressionAnalytic
  | LPAREN multipleValidAnalyticsExpressions multDivOps validAnalyticsExpression RPAREN #multDivExpressionAnalytic
  | LPAREN multipleValidAnalyticsExpressions multDivOps floatLiteral RPAREN #multDivExpressionAnalytic
  | LPAREN multipleValidAnalyticsExpressions multDivOps integerLiteral RPAREN #multDivExpressionAnalytic
  ;
  
compareValidAnalyticsExpression
  : validAnalyticsExpression comparisonOps integerLiteral
  | LPAREN validAnalyticsExpression comparisonOps integerLiteral RPAREN
  | multipleValidAnalyticsExpressions comparisonOps integerLiteral
  | LPAREN multipleValidAnalyticsExpressions comparisonOps integerLiteral RPAREN;

analyticsExpression
  : validAnalyticsExpression   
  | LPAREN analyticsExpression RPAREN                          
  | orderbyExpressionIncomplete
  | partitionExpressionIncomplete
  | comment analyticsExpression
  | analyticsExpression comment
  | multipleValidAnalyticsExpressions
  | LPAREN multipleValidAnalyticsExpressions RPAREN
  | compareValidAnalyticsExpression;

orderbyDirection : ASC | DESC;  
orderbyColumn : multiRowFieldReference orderbyDirection?;
orderbyColumns : orderbyColumn (COMMA orderbyColumn)*;
orderbyAnalyticsFunction: multiRowFunctionCall;
orderbyExpression: LCBRACK ORDERBY orderbyColumns COLON orderbyAnalyticsFunction RCBRACK;
orderbyExpressionIncomplete
  : ORDERBY orderbyColumns? COLON? orderbyAnalyticsFunction? RCBRACK? #orderbyMissingStartBracket
  | LCBRACK ORDERBY COLON? orderbyAnalyticsFunction? RCBRACK?       #orderbyMissingOrder
  | LCBRACK ORDERBY orderbyColumns orderbyAnalyticsFunction? RCBRACK? #orderbyMissingColon
  | LCBRACK ORDERBY orderbyColumns COLON RCBRACK?                   #orderbyMissingFunction
  | LCBRACK ORDERBY orderbyColumns COLON orderbyAnalyticsFunction     #orderbyMissingEndBracket;
  
partitionByColumn : multiRowFieldReference;
partitionByColumns : partitionByColumn (COMMA partitionByColumns)*;
partitionExpression : LCBRACK PARTITION partitionByColumns COLON orderbyExpression RCBRACK; 
partitionExpressionIncomplete
   : PARTITION partitionByColumns? COLON? orderbyExpression? RCBRACK?                 #partitionMissingStartBracket
   | LCBRACK PARTITION COLON? orderbyExpression? RCBRACK?                             #partitionMissingPartitions
   | LCBRACK PARTITION partitionByColumns orderbyExpression? RCBRACK?                 #partitionMissingColon
   | LCBRACK PARTITION partitionByColumns COLON RCBRACK?                            #partitionMissingOrderby
   | LCBRACK PARTITION partitionByColumns COLON orderbyExpressionIncomplete RCBRACK?  #partitionInvalidOrderby
   | LCBRACK PARTITION partitionByColumns COLON orderbyExpression                     #partitionMissingEndBracket;

lodGroupBy: multiRowFieldReference (COMMA lodGroupBy)*;
lodStatement : LCBRACK FIXED (lodGroupBy)? COLON multiRowFunctionCall RCBRACK;

lodStatementNestedExpressions
   : LCBRACK FIXED expression COLON functionCall RCBRACK
   | LCBRACK FIXED (lodGroupBy)? COLON expression RCBRACK
   | LCBRACK FIXED expression COLON expression RCBRACK;

lodStatementIncomplete
  : lodStatementMissingBrackets
  | lodStatementMissingLeftBracket
  | lodStatementMissingRightBracket
  | lodStatementMissingFixed
  | lodStatementMissingColon;

lodStatementMissingBrackets : FIXED (fieldReference (COMMA fieldReference)*)? COLON functionCall;
lodStatementMissingLeftBracket : FIXED (fieldReference (COMMA fieldReference)*)? COLON functionCall RCBRACK;
lodStatementMissingRightBracket : LCBRACK FIXED (fieldReference (COMMA fieldReference)*)? COLON functionCall;
lodStatementMissingFixed : LCBRACK (fieldReference (COMMA fieldReference)*)? COLON functionCall RCBRACK;
lodStatementMissingColon : LCBRACK FIXED (fieldReference (COMMA fieldReference)*)? functionCall RCBRACK;

lodStatementUnsupported
  : LCBRACK lodFunction=INCLUDE (lodGroupBy)? COLON functionCall RCBRACK
  | LCBRACK lodFunction=EXCLUDE (lodGroupBy)? COLON functionCall RCBRACK;

comment : COMMENT;

multDivOps : DIVIDE | MULTIPLY | MOD;
addSubOps : PLUS | MINUS;
comparisonOps : GT | LT | GTE | LTE | EQ | NEQ;

allComparisons : scalarExpression | compareValidAnalyticsExpression;

ifStatement : IF allComparisons THEN scalarExpression elseIfStatement* elseStatement? END;
elseIfStatement : ELSEIF scalarExpression THEN scalarExpression;
elseStatement : ELSE scalarExpression;

ifStatementIncomplete
  : ifStatementMissingCondition
  | ifStatementMissingThen
  | ifStatementMissingThenExpression
  | ifStatementMissingEnd
  | ifStatementMissingElse
  | ifStatementMissingElseExpression
  | ifStatementMissingElseIf
  | ifStatementMissingElseIfCondition
  | ifStatementMissingElseIfThen
  | ifStatementMissingElseIfThenExpression
  ;
ifStatementMissingCondition             : IF THEN? allComparisons? elseIfStatement* elseStatement? END?;
ifStatementMissingThen                  : IF allComparisons scalarExpression? elseIfStatement* elseStatement? END?;
ifStatementMissingThenExpression        : IF allComparisons THEN elseIfStatement* elseStatement? END?;
ifStatementMissingElse                  : IF allComparisons THEN scalarExpression elseIfStatement* scalarExpression? END?;
ifStatementMissingElseExpression        : IF allComparisons THEN scalarExpression elseIfStatement* ELSE END?;
ifStatementMissingEnd                   : IF allComparisons THEN scalarExpression elseIfStatement* elseStatement?;
ifStatementMissingElseIf                : IF allComparisons THEN scalarExpression elseIfStatement* scalarExpression? THEN? scalarExpression? elseIfStatement* elseStatement? END?;
ifStatementMissingElseIfCondition       : IF allComparisons THEN scalarExpression elseIfStatement* ELSEIF THEN? scalarExpression? elseIfStatement* elseStatement? END?;
ifStatementMissingElseIfThen            : IF allComparisons THEN scalarExpression elseIfStatement* ELSEIF scalarExpression scalarExpression? elseIfStatement* elseStatement? END?;
ifStatementMissingElseIfThenExpression  : IF allComparisons THEN scalarExpression elseIfStatement* ELSEIF scalarExpression THEN elseIfStatement* elseStatement? END?;

caseStatement : CASE allComparisons whenStatement* elseStatement? END;
whenStatement : WHEN scalarExpression THEN scalarExpression;

caseStatementIncomplete
 : caseStatementMissingCaseExpression
 | caseStatementMissingWhen
 | caseStatementMissingWhenExpression
 | caseStatementMissingThen
 | caseStatementMissingThenExpression
 | caseStatementMissingEnd
 ;
caseStatementMissingCaseExpression      : CASE;
caseStatementMissingWhen                : CASE allComparisons;
caseStatementMissingWhenExpression      : CASE allComparisons whenStatement* WHEN;
caseStatementMissingThen                : CASE allComparisons whenStatement* WHEN scalarExpression;
caseStatementMissingThenExpression      : CASE allComparisons whenStatement* WHEN scalarExpression THEN;
caseStatementMissingEnd                 : CASE allComparisons whenStatement* elseStatement?;

multiRowFieldReference
  : fieldReference
  | LPAREN fieldReference RPAREN;
  
multiRowFunctionCall
  : functionCall
  | LPAREN functionCall RPAREN;
  
fieldReference : FIELDNAME | IDENTIFIER | PARAMETER_IN_BRACKETS;

fieldReferenceIncomplete : FIELDNAME_INCOMPLETE | PARAMETER_INCOMPLETE;

functionCall : functionName=IDENTIFIER LPAREN functionArgs? RPAREN;
functionArgs : scalarExpression (COMMA scalarExpression)*;

functionCallIncomplete
 : functionCallMissingCloseParen
 ;
functionCallMissingCloseParen : functionName=IDENTIFIER LPAREN functionArgs?;

literal
 : dateLiteral
 | stringLiteral
 | integerLiteral
 | floatLiteral
 | booleanLiteral
 | nullLiteral
 ;

dateLiteral : DATELITERAL;
stringLiteral : STRINGLITERAL;
integerLiteral : INTEGER;
floatLiteral : FLOAT;
booleanLiteral : TRUE | FALSE;
nullLiteral : NULL;

literalIncomplete
 : dateLiteralIncomplete
 | stringLiteralIncomplete
 ;

dateLiteralIncomplete : DATELITERAL_INCOMPLETE;
stringLiteralIncomplete : STRINGLITERAL_INCOMPLETE;

fragment A: [aA];
fragment B: [bB];
fragment C: [cC];
fragment D: [dD];
fragment E: [eE];
fragment F: [fF];
fragment G: [gG];
fragment H: [hH];
fragment I: [iI];
fragment J: [jJ];
fragment K: [kK];
fragment L: [lL];
fragment M: [mM];
fragment N: [nN];
fragment O: [oO];
fragment P: [pP];
fragment Q: [qQ];
fragment R: [rR];
fragment S: [sS];
fragment T: [tT];
fragment U: [uU];
fragment V: [vV];
fragment W: [wW];
fragment X: [xX];
fragment Y: [yY];
fragment Z: [zZ];

IF : I F;
THEN : T H E N;
ELSE : E L S E;
ELSEIF : E L S E I F;
END : E N D;

CASE : C A S E;
WHEN : W H E N;

TRUE : T R U E;
FALSE : F A L S E;
NULL : N U L L;

AND : A N D;
OR : O R;
NOT : N O T;

ASC : A S C;
DESC : D E S C;
ORDERBY: O R D E R B Y;
PARTITION: P A R T I T I O N;

FIXED: F I X E D;
INCLUDE: I N C L U D E;
EXCLUDE: E X C L U D E;

PARAMETERS: P A R A M E T E R S;

COMMENT : '//' (~[\r\n])*;

fragment IDENTIFIER_NONDIGIT : ('a'..'z' | 'A'..'Z' | '\u0080'..'\uFFFE' | '_');
IDENTIFIER : IDENTIFIER_NONDIGIT (IDENTIFIER_NONDIGIT | DIGIT)*;

fragment BLOCK : [A-Za-z0-9] [A-Za-z0-9] [A-Za-z0-9] [A-Za-z0-9];
fragment GUID: BLOCK BLOCK '-' BLOCK '-' BLOCK '-' BLOCK '-' BLOCK BLOCK BLOCK;

PARAMETER : PARAMETERS'.'GUID;
PARAMETER_IN_BRACKETS: '[' PARAMETER ']';
PARAMETER_INCOMPLETE: '['* PARAMETER_IN_BRACKETS ']'*;

fragment FIELDNAME_BODY_IN_BRACKETS : (~[\]] | ']]')*;
FIELDNAME : '[' FIELDNAME_BODY_IN_BRACKETS ']';
FIELDNAME_INCOMPLETE : '[' FIELDNAME_BODY_IN_BRACKETS;

fragment STRINGLITERAL_BODY_IN_DOUBLE_QUOTES : (~["] | '""')*;
fragment STRINGLITERAL_BODY_IN_SINGLE_QUOTES : (~['] | '\'\'')*;
fragment STRINGLITERAL_IN_DOUBLE_QUOTES : '"' STRINGLITERAL_BODY_IN_DOUBLE_QUOTES '"';
fragment STRINGLITERAL_IN_SINGLE_QUOTES : '\'' STRINGLITERAL_BODY_IN_SINGLE_QUOTES '\'';
STRINGLITERAL : STRINGLITERAL_IN_DOUBLE_QUOTES | STRINGLITERAL_IN_SINGLE_QUOTES;
fragment STRINGLITERAL_INCOMPLETE_IN_DOUBLE_QUOTES : '"' STRINGLITERAL_BODY_IN_DOUBLE_QUOTES;
fragment STRINGLITERAL_INCOMPLETE_IN_SINGLE_QUOTES : '\'' STRINGLITERAL_BODY_IN_SINGLE_QUOTES;
STRINGLITERAL_INCOMPLETE : STRINGLITERAL_INCOMPLETE_IN_DOUBLE_QUOTES | STRINGLITERAL_INCOMPLETE_IN_SINGLE_QUOTES;

fragment DATELITERAL_BODY : (~[#\r\n'"])*;
DATELITERAL : '#' DATELITERAL_BODY '#';
DATELITERAL_INCOMPLETE : '#' DATELITERAL_BODY;

fragment DIGIT : '0'..'9';
INTEGER : DIGIT+ (E DIGIT+)?;
FLOAT : DIGIT* '.' DIGIT+ (E (PLUS|MINUS)? DIGIT+)?;

// no LBRACKET because FIELDNAME_INCOMPLETE covers that case
RBRACKET: ']';

LCBRACK : '{';
RCBRACK : '}';

LPAREN : '(';
RPAREN : ')';

COMMA : ',';
COLON: ':';

PLUS : '+';
MINUS : '-';
DIVIDE : '/';
MULTIPLY : '*';
MOD : '%';
EXPONENT : '^';

GT : '>';
LT : '<';
GTE : '>=';
LTE : '<=';
EQ : '==' | '=';
NEQ : '!=' | '<>';

WHITESPACE : [ \r\n\t]+ -> channel (HIDDEN);