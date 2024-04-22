# Dunes

Credits to [apezord](https://github.com/apezord/ord-dogecoin) for providing the basic migration of Ordinals on Dogecoin and the official [Ordinals](https://github.com/ordinals/ord) contributors which this document and the overall migration of Runes to Dunes on Dogecoin is based on.

## ⚠️⚠️⚠️ Disclaimer ⚠️⚠️⚠️

This documentation is subject to change, and there is no guarantee of its completeness or accuracy.

### General

Dunes allow Dogecoin transactions to etch, mint, and transfer Dogecoin-native digital commodities.

Whereas every inscription is unique, every unit of a dune is the same. They are interchangeable tokens, fit for a variety of purposes.

### Dunestones

Dune protocol messages, called dunestones, are stored in Dogecoin transaction outputs.

A dunestone output's script pubkey begins with an `OP_RETURN`, followed by `D`, followed by zero or more data pushes. These data pushes are concatenated and decoded into a sequence of 128-bit integers, and finally parsed into a dunestone.

A transaction may have at most one dunestone.

A dunestone may etch a new dune, mint an existing dune, and transfer dunes from a transaction's inputs to its outputs.

A transaction output may hold balances of any number of dunes.

Dunes are identified by IDs, which consist of the block in which a dune was etched and the index of the etching transaction within that block, represented in text as `BLOCK:TX`. For example, the ID of the dune minted in the 20th transaction of the 500th block is `500:20`.

### Etching

Dunes come into existence by being etched. Etching creates a dune and sets its properties. Once set, these properties are immutable, even to its etcher.

##### Name

Names consist of the letters `A` through `Z` and are between one and twenty-eight characters long. For example `WHOLETTHEDUNESOUT` is a dune name.

Names may contain spacers, represented as bullets, to aid readability. `WHOLETTHEDUNESOUT` might be etched as `WHO•LET•THE•DUNES•OUT`.

The uniqueness of a name does not depend on spacers. Thus, a dune may not be etched with the same sequence of letters as an existing dune, even if it has different spacers.

##### Divisibility

A dune's divisibility is how finely it may be divided into its atomic units. Divisibility is expressed as the number of digits permissible after the decimal point in an amount of dunes. A dune with divisibility 0 may not be divided. A unit of a dune with divisibility 1 may be divided into ten sub-units, a dune with divisibility 2 may be divided into a hundred, and so on.

##### Symbol

A dune's currency symbol is a single Unicode code point, for example `$`, `⧉`, or `🧿`, displayed after quantities of that dune.

101 atomic units of a dune with divisibility 2 and symbol `🧿` would be rendered as `1.01 🧿`.

If a dune does not have a symbol, the generic currency sign `¤`, also called a scarab, should be used.

##### Premine

The etcher of a dune may optionally allocate to themselves units of the dune being etched. This allocation is called a premine.

##### Terms

A dune may have an open mint, allowing anyone to create and allocate units of that dune for themselves. An open mint is subject to terms, which are set upon etching.

A mint is open while all terms of the mint are satisfied, and closed when any of them are not. For example, a mint may be limited to a starting height, an ending height, and a cap, and will be open between the starting height and ending height, or until the cap is reached, whichever comes first.

##### Cap

The number of times a dune may be minted is its cap. A mint is closed once the cap is reached.

##### Amount

Each mint transaction can create an amount of new units up to the defined amount (limit) of a dune.

##### Start Height

A mint is open starting in the block with the given start height.

##### End Height

A dune may not be minted in or after the block with the given end height.

##### Start Offset

A mint is open starting in the block whose height is equal to the start offset plus the height of the block in which the dune was etched.

##### End Offset

A dune may not be minted in or after the block whose height is equal to the end offset plus the height of the block in which the dune was etched.

##### Minting

While a dune's mint is open, anyone may create a mint transaction that creates an amount of new units of that dune, subject to the terms of the mint.

##### Transferring

When transaction inputs contain dunes, or new dunes are created by a premine or mint, those dunes are transferred to that transaction's outputs. A transaction's dunestone may change how input dunes transfer to outputs.

##### Edicts

A dunestone may contain any number of edicts. Edicts consist of a dune ID, an amount, and an output number. Edicts are processed in order, allocating unallocated dunes to outputs.

##### Pointer

After all edicts are processed, remaining unallocated dunes are transferred to the transaction's first `non-OP_RETURN` output. A dunestone may optionally contain a pointer that specifies an alternative default output.

##### Burning

Dunes may be burned by transferring them to an `OP_RETURN` output with an edict or pointer.

##### Cenotaphs

Dunestones may be malformed for a number of reasons, including non-pushdata opcodes in the dunestone `OP_RETURN`, invalid varints, or unrecognized dunestone fields.

Malformed dunestones are termed cenotaphs.

Dunes input to a transaction with a cenotaph are burned. Dunes etched in a transaction with a cenotaph are set as unmintable. Mints in a transaction with a cenotaph count towards the mint cap, but the minted dunes are burned.

Cenotaphs are an upgrade mechanism, allowing dunestones to be given new semantics that change how dunes are created and transferred, while not misleading unupgraded clients as to the location of those dunes, as unupgraded clients will see those dunes as having been burned.
