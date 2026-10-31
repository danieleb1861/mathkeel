# Mapping a chain

## Node choice

Map statements a reader could get wrong: assumptions, definitions, equations,
conventions, parameters and closed lists. Use one node per statement.

`.mathkeel/map.toon` holds `chains`, `contracts` and `nodes`, in TOON. A node needs
`id`, `chain`, `kind`, `title` and `status`; add `latex`, `doc`, `code`, `units`,
`depends_on`, `contracts`, `verified_by`, `proof` and `pinned_to_code` as they
apply.

`examples/demo/.mathkeel/map.toon` shows the format. Array headers state their
length, and a value holding a comma, colon, quote or leading space needs double
quotes, with backslashes doubled. `map lint` reports a syntax error. A repository
that already has `map.json` keeps it; the two files cannot coexist.

## Anchors

Point at text; do not copy it.

- **Code:** `path` and `symbol` only. The hash covers the whole symbol, and a quote
  beside a symbol is never compared, so `map lint` warns about it.
- **A function too long to watch whole:** `path` and one short `quote`, with no
  symbol. This is the only case for copying a line of code.
- **Documentation:** `path` and the shortest unique phrase, three to six words.
  The hash covers its whole paragraph or fence, whatever the length of the quote.

Hashes, baseline and inventory live in `map.lock.toon`. `map freeze` and `accept`
write it; never read or edit it.

## Status

Use the lowest status the evidence supports:

| Status | Evidence |
| --- | --- |
| `stated` | The documentation asserts it |
| `argued` | The documentation gives an argument |
| `implemented` | Code anchors exist |
| `numerically_checked` | An independent contract passes |
| `formally_checked` | A proof assistant or solver checked it |

Record the proof separately in `proof.state`: `absent`, `sketch` or `checked`.
A test definition is not a passing result.

## Contracts

Reuse before writing. When a test in the repository computes the documented
formula and reaches its branches, declare that test as the contract and write no
code. A test that only names the function, or checks a single case of a piecewise
formula, does not cover the node. If a test was written from the code rather than
the documentation, mark the node `pinned_to_code`.

For what no test covers, write the smallest contract: seeded synthetic input, and
identities, limits or hand-computed values before a rewrite of the formula. Use
`literal` for documented constants, `census` for closed lists and `unit` for
dimensions, with no network and no private data. A contract that only repeats the
implementation detects change, not error: mark that node `pinned_to_code`.

Cover the chain's riskiest node first. Whatever stays unmapped is unprotected,
so report it through gaps and the uncharted share.
