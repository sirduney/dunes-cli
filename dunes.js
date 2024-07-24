#!/usr/bin/env node

const dogecore = require("bitcore-lib-doge");
const axios = require("axios");
const axiosRetry = require("axios-retry").default;
const cheerio = require("cheerio");
const fs = require("fs");
const dotenv = require("dotenv");
const { PrivateKey, Address, Transaction, Script, Opcode } = dogecore;
const { program } = require("commander");
const bb26 = require("base26");
const prompts = require("prompts");

const axiosRetryOptions = {
  retries: 10,
  retryDelay: axiosRetry.exponentialDelay,
};

axiosRetry(axios, axiosRetryOptions);

dotenv.config();

if (process.env.TESTNET == "true") {
  dogecore.Networks.defaultNetwork = dogecore.Networks.testnet;
}

if (process.env.FEE_PER_KB) {
  Transaction.FEE_PER_KB = parseInt(process.env.FEE_PER_KB);
} else {
  Transaction.FEE_PER_KB = 100000000;
}

const WALLET_PATH = process.env.WALLET || ".wallet.json";

const IDENTIFIER = stringToCharCodes(process.env.PROTOCOL_IDENTIFIER);

const MAX_SCRIPT_ELEMENT_SIZE = 520;

class PushBytes {
  constructor(bytes) {
    this.bytes = Buffer.from(bytes);
  }

  static fromSliceUnchecked(bytes) {
    return new PushBytes(bytes);
  }

  static fromMutSliceUnchecked(bytes) {
    return new PushBytes(bytes);
  }

  static empty() {
    return new PushBytes([]);
  }

  asBytes() {
    return this.bytes;
  }

  asMutBytes() {
    return this.bytes;
  }
}

// Encode a u128 value to a byte array
function varIntEncode(n) {
  const out = new Array(19).fill(0);
  let i = 18;

  out[i] = Number(BigInt(n) & 0b01111111n);

  while (BigInt(n) > 0b01111111n) {
    n = BigInt(n) / 128n - 1n;
    i -= 1;
    out[i] = Number(BigInt(n) | 0b10000000n);
  }

  return out.slice(i);
}

class Tag {
  static Body = 0;
  static Flags = 2;
  static Dune = 4;
  static Limit = 6;
  static OffsetEnd = 8;
  static Deadline = 10;
  static Pointer = 12;
  static HeightStart = 14;
  static OffsetStart = 16;
  static HeightEnd = 18;
  static Cap = 20;
  static Premine = 22;

  static Cenotaph = 254;

  static Divisibility = 1;
  static Spacers = 3;
  static Symbol = 5;
  static Nop = 255;

  static take(tag, fields) {
    return fields[tag];
  }

  static encode(tag, value, payload) {
    payload.push(varIntEncode(tag));
    if (tag == Tag.Dune) payload.push(encodeToTuple(value));
    else payload.push(varIntEncode(value));
  }
}

class Flag {
  static Etch = 0;
  static Terms = 1;
  static Turbo = 2;
  static Cenotaph = 127;

  static mask(flag) {
    return BigInt(1) << BigInt(flag);
  }

  static take(flag, flags) {
    const mask = Flag.mask(flag);
    const set = (flags & mask) !== 0n;
    flags &= ~mask;
    return set;
  }

  static set(flag, flags) {
    flags |= Flag.mask(flag);
  }
}

// Construct the OP_RETURN dune script with encoding of given values
function constructScript(
  etching = null,
  pointer = undefined,
  cenotaph = null,
  edicts = []
) {
  const payload = [];

  if (etching) {
    // Setting flags for etching and minting
    let flags = Number(Flag.mask(Flag.Etch));
    if (etching.turbo) flags |= Number(Flag.mask(Flag.Turbo));
    if (etching.terms) flags |= Number(Flag.mask(Flag.Terms));
    Tag.encode(Tag.Flags, flags, payload);

    if (etching.dune) Tag.encode(Tag.Dune, etching.dune, payload);
    if (etching.terms) {
      if (etching.terms.limit)
        Tag.encode(Tag.Limit, etching.terms.limit, payload);
      if (etching.terms.cap) Tag.encode(Tag.Cap, etching.terms.cap, payload);
      if (etching.terms.offsetStart)
        Tag.encode(Tag.OffsetStart, etching.terms.offsetStart, payload);
      if (etching.terms.offsetEnd)
        Tag.encode(Tag.OffsetEnd, etching.terms.offsetEnd, payload);
      if (etching.terms.heightStart)
        Tag.encode(Tag.HeightStart, etching.terms.heightStart, payload);
      if (etching.terms.heightEnd)
        Tag.encode(Tag.HeightEnd, etching.terms.heightEnd, payload);
    }
    if (etching.divisibility !== 0)
      Tag.encode(Tag.Divisibility, etching.divisibility, payload);
    if (etching.spacers !== 0)
      Tag.encode(Tag.Spacers, etching.spacers, payload);
    if (etching.symbol) Tag.encode(Tag.Symbol, etching.symbol, payload);
    if (etching.premine) Tag.encode(Tag.Premine, etching.premine, payload);
  }

  if (pointer !== undefined) {
    Tag.encode(Tag.Pointer, pointer, payload);
  }

  if (cenotaph) {
    Tag.encode(Tag.Cenotaph, 0, payload);
  }

  if (edicts && edicts.length > 0) {
    payload.push(varIntEncode(Tag.Body));

    const sortedEdicts = edicts.slice().sort((a, b) => {
      const idA = BigInt(a.id);
      const idB = BigInt(b.id);

      return idA < idB ? -1 : idA > idB ? 1 : 0;
    });
    let id = 0;

    for (const edict of sortedEdicts) {
      if (typeof edict.id === "bigint")
        payload.push(varIntEncode(edict.id - BigInt(id)));
      else payload.push(varIntEncode(edict.id - id));
      payload.push(varIntEncode(edict.amount));
      payload.push(varIntEncode(edict.output));
      id = edict.id;
    }
  }

  // Create script with protocol message
  let script = createScriptWithProtocolMsg();

  // Flatten the nested arrays in the tuple representation
  const flattenedTuple = payload.flat();

  // Push payload bytes to script
  for (let i = 0; i < flattenedTuple.length; i += MAX_SCRIPT_ELEMENT_SIZE) {
    const chunk = flattenedTuple.slice(i, i + MAX_SCRIPT_ELEMENT_SIZE);
    const push = PushBytes.fromSliceUnchecked(chunk);
    script.add(Buffer.from(push.asBytes()));
  }

  return script;
}

class SpacedDune {
  constructor(dune, spacers) {
    this.dune = parseDuneFromString(dune);
    this.spacers = spacers;
  }
}

class Dune {
  constructor(value) {
    this.value = BigInt(value);
  }
}

function parseDuneFromString(s) {
  let x = BigInt(0);

  for (let i = 0; i < s.length; i++) {
    if (i > 0) {
      x += BigInt(1);
    }

    x *= BigInt(26);

    const charCode = s.charCodeAt(i);

    if (charCode >= "A".charCodeAt(0) && charCode <= "Z".charCodeAt(0)) {
      x += BigInt(charCode - "A".charCodeAt(0));
    } else {
      throw new Error(`Invalid character in dune name: ${s[i]}`);
    }
  }

  return new Dune(x);
}

// Function to parse a string into a SpacedDune in Node.js
function spacedDunefromStr(s) {
  let dune = "";
  let spacers = 0;

  for (const c of s) {
    switch (true) {
      case /[A-Z]/.test(c):
        dune += c;
        break;
      case /[.•]/.test(c):
        const flag = 1 << (dune.length - 1);
        if ((spacers & flag) !== 0) {
          throw new Error("double spacer");
        }
        spacers |= flag;
        break;
      default:
        throw new Error("invalid character");
    }
  }

  if (32 - Math.clz32(spacers) >= dune.length) {
    throw new Error("trailing spacer");
  }

  return new SpacedDune(dune, spacers);
}

class Edict {
  // Constructor for Edict
  constructor(id, amount, output) {
    this.id = id;
    this.amount = amount;
    this.output = output;
  }
}

class Terms {
  constructor(limit, cap, offsetStart, offsetEnd, heightStart, heightEnd) {
    this.limit = limit !== undefined ? limit : null;
    this.cap = cap !== undefined ? cap : null;
    this.offsetStart = offsetStart !== undefined ? offsetStart : null;
    this.offsetEnd = offsetEnd !== undefined ? offsetEnd : null;
    this.heightStart = heightStart !== undefined ? heightStart : null;
    this.heightEnd = heightEnd !== undefined ? heightEnd : null;
  }
}

class Etching {
  // Constructor for Etching
  constructor(divisibility, terms, turbo, premine, dune, spacers, symbol) {
    this.divisibility = divisibility;
    this.terms = terms !== undefined ? terms : null;
    this.turbo = turbo !== undefined ? turbo : null;
    this.premine = premine !== undefined ? premine : null;
    this.dune = dune;
    this.spacers = spacers;
    this.symbol = symbol;
  }
}

function stringToCharCodes(inputString) {
  const charCodes = [];
  for (let i = 0; i < inputString.length; i++) {
    charCodes.push(inputString.charCodeAt(i));
  }
  return charCodes;
}

const STEPS = [
  0n,
  26n,
  702n,
  18278n,
  475254n,
  12356630n,
  321272406n,
  8353082582n,
  217180147158n,
  5646683826134n,
  146813779479510n,
  3817158266467286n,
  99246114928149462n,
  2580398988131886038n,
  67090373691429037014n,
  1744349715977154962390n,
  45353092615406029022166n,
  1179180408000556754576342n,
  30658690608014475618984918n,
  797125955808376366093607894n,
  20725274851017785518433805270n,
  538857146126462423479278937046n,
  14010285799288023010461252363222n,
  364267430781488598271992561443798n,
  9470953200318703555071806597538774n,
  246244783208286292431866971536008150n,
  6402364363415443603228541259936211926n,
  166461473448801533683942072758341510102n,
];

const SUBSIDY_HALVING_INTERVAL_10X = 2100000n;
const FIRST_DUNE_HEIGHT = 5084000n;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function format(formatter) {
  let n = BigInt(this._value);

  if (n === 2n ** 128n - 1n) {
    return formatter.write("BCGDENLQRQWDSLRUGSNLBTMFIJAV");
  }

  n += 1n;
  let symbol = "";

  while (n > 0n) {
    symbol += ALPHABET.charAt(Number((n - 1n) % 26n));
    n = (n - 1n) / 26n;
  }

  for (const c of symbol.split("").reverse()) {
    formatter.write(c);
  }
}

const formatter = {
  output: "",
  write(str) {
    this.output += str;
    return this;
  },
};

function minimumAtHeight(height) {
  const offset = BigInt(height) + 1n;

  const INTERVAL = SUBSIDY_HALVING_INTERVAL_10X / 12n;

  const start = FIRST_DUNE_HEIGHT;
  const end = start + SUBSIDY_HALVING_INTERVAL_10X;

  if (offset < start) {
    return BigInt(STEPS[12]);
  }

  if (offset >= end) {
    return 0n;
  }

  const progress = offset - start;

  const length = BigInt(12 - Math.floor(Number(progress / INTERVAL)));

  const endValue = BigInt(STEPS[length - 1n]);
  const startValue = BigInt(STEPS[length]);

  const remainder = progress % INTERVAL;

  return startValue - ((startValue - endValue) * remainder) / INTERVAL;
}

function encodeToTuple(n) {
  const tupleRepresentation = [];

  tupleRepresentation.push(Number(n & BigInt(0b0111_1111)));

  while (n > BigInt(0b0111_1111)) {
    n = n / BigInt(128) - BigInt(1);
    tupleRepresentation.unshift(
      Number((n & BigInt(0b0111_1111)) | BigInt(0b1000_0000))
    );
  }

  return tupleRepresentation;
}

const getDuneBalance = async (dune_name, address) => {
  const utxos = await fetchAllUnspentOutputs(address);
  let balance = 0n;
  const utxoHashes = utxos.map((utxo) => `${utxo.txid}:${utxo.vout}`);
  const chunkSize = 10; // Size of each chunk

  // Function to chunk the utxoHashes array
  const chunkedUtxoHashes = [];
  for (let i = 0; i < utxoHashes.length; i += chunkSize) {
    chunkedUtxoHashes.push(utxoHashes.slice(i, i + chunkSize));
  }

  // Process each chunk
  for (const chunk of chunkedUtxoHashes) {
    const allDunes = await getDunesForUtxos(chunk);

    for (const dunesInfo of allDunes) {
      for (const singleDunesInfo of dunesInfo.dunes) {
        const [name, { amount }] = singleDunesInfo;

        if (name === dune_name) {
          balance += BigInt(amount);
        }
      }
    }
  }

  return balance;
};

program
  .command("printDunes")
  .description("Prints dunes of wallet")
  .action(async () => {
    let wallet = JSON.parse(fs.readFileSync(WALLET_PATH));
    const dunes = [];
    const getUtxosWithDunes = [];
    const CHUNK_SIZE = 10;

    // Helper function to process a chunk of UTXOs
    async function processChunk(utxosChunk, startIndex) {
      const promises = utxosChunk.map((utxo, index) => {
        console.log(
          `Processing utxo number ${startIndex + index} of ${
            wallet.utxos.length
          }`
        );
        return getDunesForUtxo(`${utxo.txid}:${utxo.vout}`).then(
          (dunesOnUtxo) => {
            if (dunesOnUtxo.length > 0) {
              getUtxosWithDunes.push(utxo);
            }
            return dunesOnUtxo;
          }
        );
      });

      const results = await Promise.all(promises);
      for (const result of results) {
        dunes.push(...result);
      }
    }

    // Process UTXOs in chunks
    for (let i = 0; i < wallet.utxos.length; i += CHUNK_SIZE) {
      const chunk = wallet.utxos.slice(i, i + CHUNK_SIZE);
      await processChunk(chunk, i);
    }

    console.log(dunes);
    console.log(`Total dunes: ${dunes.length}`);
    console.log(`Number of utxos with dunes: ${getUtxosWithDunes.length}`);
  });

program
  .command("printDuneBalance")
  .argument("<dune_name>", "Dune name")
  .argument("<address>", "Wallet address")
  .description("Prints tick balance of wallet")
  .action(async (dune_name, address) => {
    const balance = await getDuneBalance(dune_name, address);

    // Output the total balance
    console.log(`${balance.toString()} ${dune_name}`);
  });

program
  .command("printSafeUtxos")
  .description("Prints utxos that are safe to spend")
  .action(async () => {
    const safeUtxos = await getUtxosWithOutDunes();
    console.log(safeUtxos);
    console.log(`Number of safe utxos: ${safeUtxos.length}`);
  });

const getUtxosWithOutDunes = async () => {
  let wallet = JSON.parse(fs.readFileSync(WALLET_PATH));

  const walletBalanceFromOrd = await axios.get(
    `${process.env.ORD}dunes/balance/${wallet.address}?show_all=true`
  );

  const duneOutputMap = new Map();
  for (const dune of walletBalanceFromOrd.data.dunes) {
    for (const balance of dune.balances) {
      duneOutputMap.set(`${balance.txid}:${balance.vout}`, {
        ...balance,
        dune: dune.dune,
      });
    }
  }

  return wallet.utxos.filter(
    (utxo) => !duneOutputMap.has(`${utxo.txid}:${utxo.vout}`)
  );
};

const parseDuneId = (id, claim = false) => {
  // Check if Dune ID is in the expected format
  const regex1 = /^\d+\:\d+$/;
  const regex2 = /^\d+\/\d+$/;

  if (!regex1.test(id) && !regex2.test(id))
    console.log(
      `Dune ID ${id} is not in the expected format e.g. 1234:1 or 1234/1`
    );

  // Parse the id string to get height and index
  const [heightStr, indexStr] = regex1.test(id) ? id.split(":") : id.split("/");
  const height = parseInt(heightStr, 10);
  const index = parseInt(indexStr, 10);

  // Set the bits in the id using bitwise OR
  let duneId = (BigInt(height) << BigInt(16)) | BigInt(index);

  // For minting set CLAIM_BIT
  if (claim) {
    const CLAIM_BIT = BigInt(1) << BigInt(48);
    duneId |= CLAIM_BIT;
  }

  return duneId;
};

const createScriptWithProtocolMsg = () => {
  // create an OP_RETURN script with the protocol message
  return new dogecore.Script().add("OP_RETURN").add(Buffer.from(IDENTIFIER));
};

program
  .command("sendDuneMulti")
  .description("Send dune from the utxo to multiple receivers")
  .argument("<txhash>", "Hash from tx")
  .argument("<vout>", "Output from tx")
  .argument("<dune>", "Dune to send")
  .argument("<decimals>", "Decimals of the dune to send")
  .argument("<amounts>", "Amounts to send, separated by comma")
  .argument("<addresses>", "Receiver's addresses, separated by comma")
  .action(async (txhash, vout, dune, decimals, amounts, addresses) => {
    const amountsAsArray = amounts.split(",").map((amount) => Number(amount));
    const addressesAsArray = addresses.split(",");
    if (amountsAsArray.length != addressesAsArray.length) {
      console.error(
        `length of amounts ${amountsAsArray.length} and addresses ${addressesAsArray.length} are different`
      );
      process.exit(1);
    }
    try {
      await walletSendDunes(
        txhash,
        vout,
        dune,
        decimals,
        amountsAsArray,
        addressesAsArray
      );
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  });

program
  .command("sendDunesNoProtocol")
  .description("Send dunes but without a protocol message")
  .argument("<address>", "Receiver's address")
  .argument("<utxo-amount>", "Number of dune utxos to send")
  .argument("<dune>", "Dune to send")
  .action(async (address, utxoAmount, dune) => {
    try {
      const res = await walletSendDunesNoProtocol(
        address,
        parseInt(utxoAmount),
        dune
      );
      console.info(`Broadcasted transaction: ${JSON.stringify(res)}`);
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  });

// sends the full balance of the specified dune
async function walletSendDunes(
  txhash,
  vout,
  dune,
  decimals,
  amounts,
  addresses
) {
  let wallet = JSON.parse(fs.readFileSync(WALLET_PATH));

  const dune_utxo = wallet.utxos.find(
    (utxo) => utxo.txid == txhash && utxo.vout == vout
  );
  if (!dune_utxo) {
    console.error(`utxo ${txhash}:${vout} not found`);
    throw new Error(`utxo ${txhash}:${vout} not found`);
  }

  const dunes = await getDunesForUtxo(`${dune_utxo.txid}:${dune_utxo.vout}`);
  if (dunes.length == 0) throw new Error("no dunes");

  // check if the dune is in the utxo and if we have enough amount
  const duneOnUtxo = dunes.find((d) => d.dune == dune);

  // Extract the numeric part from duneOnUtxo.amount as a BigInt
  let duneOnUtxoAmount = BigInt(duneOnUtxo.amount.match(/\d+/)[0]);

  // Add the decimals
  duneOnUtxoAmount *= BigInt(10 ** decimals);

  if (!dune) throw new Error("dune not found");
  const totalAmount = amounts.reduce(
    (acc, curr) => acc + BigInt(curr),
    BigInt(0)
  );
  console.log("totalAmount", totalAmount);
  if (duneOnUtxoAmount < totalAmount) throw new Error("not enough dunes");

  // Define default output where the sender receives unallocated dunes
  const DEFAULT_OUTPUT = 1;
  // Define output offset for receivers of dunes
  const OFFSET = 2;

  // ask the user to confirm in the cli
  const response = await prompts({
    type: "confirm",
    name: "value",
    message: `Transferring ${totalAmount} of ${dune}. Are you sure you want to proceed?`,
    initial: true,
  });

  if (!response.value) {
    throw new Error("Transaction aborted");
  }

  let tx = new Transaction();

  tx.from(dune_utxo);

  // we get the dune
  const { id, divisibility, limit } = await getDune(dune);
  console.log("id", id);

  // parse given id string to dune id
  const duneId = parseDuneId(id);

  /**
   * we have an index-offset of 2
   * - the first output (index 0) is the protocol message
   * - the second output (index 1) is where we put the dunes which are on input utxos which shouldn't be transfered
   * */
  const edicts = [];
  for (let i = 0; i < amounts.length; i++) {
    edicts.push(new Edict(duneId, amounts[i], i + OFFSET));
  }

  // Create payload and parse it into an OP_RETURN script with protocol message
  const script = constructScript(null, DEFAULT_OUTPUT, null, edicts);

  // Add output with OP_RETURN Dune assignment script
  tx.addOutput(
    new dogecore.Transaction.Output({ script: script, satoshis: 0 })
  );

  // add one output to the sender for the dunes that are not transferred
  tx.to(wallet.address, 100_000);

  // the output after the protocol message will carry the dune balance if no payload is specified
  for (const address of addresses) {
    tx.to(address, 100_000);
  }

  // we fund the tx
  await fund(wallet, tx);

  if (tx.inputAmount < tx.outputAmount + tx.getFee()) {
    throw new Error("not enough funds");
  }

  console.log(tx.toObject());
  await broadcast(tx, true);

  console.log(tx.hash);
}

async function walletSendDunesNoProtocol(address, utxoAmount, dune) {
  let wallet = JSON.parse(fs.readFileSync(WALLET_PATH));

  const walletBalanceFromOrd = await axios.get(
    `${process.env.ORD}dunes/balance/${wallet.address}?show_all=true`
  );

  const duneOutputMap = new Map();
  for (const dune of walletBalanceFromOrd.data.dunes) {
    for (const balance of dune.balances) {
      duneOutputMap.set(balance.txid, {
        ...balance,
        dune: dune.dune,
      });
    }
  }

  const nonDuneUtxos = wallet.utxos.filter(
    (utxo) => !duneOutputMap.has(utxo.txid)
  );

  if (nonDuneUtxos.length === 0) {
    throw new Error("no utxos without dunes found");
  }

  const gasUtxo = nonDuneUtxos.find((utxo) => utxo.satoshis > 100_000_000);

  if (!gasUtxo) {
    throw new Error(`no gas utxo found`);
  }

  let dunesUtxosValue = 0;
  const dunesUtxos = [];

  for (const utxo of wallet.utxos) {
    if (dunesUtxos.length >= utxoAmount) {
      break;
    }

    if (duneOutputMap.has(utxo.txid)) {
      const duneOutput = duneOutputMap.get(utxo.txid);
      if (duneOutput.dune === dune) {
        dunesUtxos.push(utxo);
        dunesUtxosValue += utxo.satoshis;
      }
    }
  }

  if (dunesUtxos.length < utxoAmount) {
    throw new Error(`not enough dune utxos found`);
  }

  const response = await prompts({
    type: "confirm",
    name: "value",
    message: `Transferring ${utxoAmount} utxos of ${dune}. Are you sure you want to proceed?`,
    initial: true,
  });

  if (!response.value) {
    throw new Error("Transaction aborted");
  }

  let tx = new Transaction();
  tx.from(dunesUtxos);
  tx.to(address, dunesUtxosValue);

  await fund(wallet, tx);
  return await broadcast(tx, true);
}

const _mintDune = async (id, amount, receiver) => {
  console.log("Minting Dune...");
  console.log(id, amount, receiver);

  // Parse given id string to dune id
  const duneId = parseDuneId(id, true);

  if (amount == 0) {
    const { id_, divisibility, limit } = await getDune(id);
    amount = BigInt(limit) * BigInt(10 ** divisibility);
  }

  // mint dune with encoded id, amount on output 1
  const edicts = [new Edict(duneId, amount, 1)];
  console.log(edicts);

  // Create script for given dune statements
  const script = constructScript(null, undefined, null, edicts);

  // getting the wallet balance
  let wallet = JSON.parse(fs.readFileSync(WALLET_PATH));
  let balance = wallet.utxos.reduce((acc, curr) => acc + curr.satoshis, 0);
  if (balance == 0) throw new Error("no funds");

  // creating new tx
  let tx = new Transaction();

  // output carries the protocol message
  tx.addOutput(
    new dogecore.Transaction.Output({ script: script, satoshis: 0 })
  );

  // add receiver output holding dune amount
  tx.to(receiver, 100_000);

  await fund(wallet, tx);

  try {
    await broadcast(tx, true);
  } catch (e) {
    console.log(e);
  }

  console.log(tx.hash);
};

program
  .command("mintDune")
  .description("Mint a Dune")
  .argument("<id>", "id of the dune in format block:index e.g. 5927764:2")
  .argument(
    "<amount>",
    "amount to mint (0 takes the limit of the dune as amount)"
  )
  .argument("<receiver>", "address of the receiver")
  .action(_mintDune);

function isSingleEmoji(str) {
  const emojiRegex = /[\p{Emoji}]/gu;

  const matches = str.match(emojiRegex);

  return matches ? matches.length === 1 : false;
}

program
  .command("deployOpenDune")
  .description("Deploy a Dune that is open for mint")
  .argument("<tick>", "Tick for the dune")
  .argument("<symbol>", "symbol")
  .argument("<limit>", "Max amount that can be minted in one transaction")
  .argument("<divisibility>", "divisibility of the dune. Max 38")
  .argument("<cap>", "Max limit that can be minted overall")
  .argument("<heightStart>", "Absolute block height where minting opens")
  .argument("<heightEnd>", "Absolute block height where minting closes")
  .argument("<offsetStart>", "Relative block height where minting opens")
  .argument(
    "<offsetEnd>",
    "Relative block height where minting closes (former known as term)"
  )
  .argument(
    "<premine>",
    "Amount of allocated dunes to the etcher while etching"
  )
  .argument(
    "<turbo>",
    "Marks this etching as opting into future protocol changes."
  )
  .argument(
    "<openMint>",
    "Set this to true to allow minting, taking terms (limit, cap, height, offset) as restrictions"
  )
  .action(
    async (
      tick,
      symbol,
      limit,
      divisibility,
      cap,
      heightStart,
      heightEnd,
      offsetStart,
      offsetEnd,
      premine,
      turbo,
      openMint
    ) => {
      console.log("Deploying open Dune...");
      console.log(
        tick,
        symbol,
        limit,
        divisibility,
        cap,
        heightStart,
        heightEnd,
        offsetStart,
        offsetEnd,
        premine,
        turbo,
        openMint
      );

      cap = cap === "null" ? null : cap;
      heightStart = heightStart === "null" ? null : heightStart;
      heightEnd = heightEnd === "null" ? null : heightEnd;
      offsetStart = offsetStart === "null" ? null : offsetStart;
      offsetEnd = offsetEnd === "null" ? null : offsetEnd;
      premine = premine === "null" ? null : premine;
      turbo = turbo === "null" ? null : turbo === "true";

      openMint = openMint.toLowerCase() === "true";

      if (symbol) {
        if (symbol.length !== 1 && !isSingleEmoji(symbol)) {
          console.error(
            `Error: The argument symbol should have exactly 1 character, but is '${symbol}'`
          );
          process.exit(1);
        }
      }

      const spacedDune = spacedDunefromStr(tick);

      const blockcount = await getblockcount();
      const mininumAtCurrentHeight = minimumAtHeight(blockcount.data.result);

      if (spacedDune.dune.value < mininumAtCurrentHeight) {
        const minAtCurrentHeightObj = { _value: mininumAtCurrentHeight };
        format.call(minAtCurrentHeightObj, formatter);
        console.error("Dune characters are invalid at current height.");
        process.stdout.write(
          `minimum at current height: ${mininumAtCurrentHeight} possible lowest tick: ${formatter.output}\n`
        );
        console.log(`dune: ${tick} value: ${spacedDune.dune.value}`);
        process.exit(1);
      }

      const terms = openMint
        ? new Terms(limit, cap, offsetStart, offsetEnd, heightStart, heightEnd)
        : null;

      const etching = new Etching(
        divisibility,
        terms,
        turbo,
        premine,
        spacedDune.dune.value,
        spacedDune.spacers,
        symbol.codePointAt()
      );

      // create script for given dune statements
      const script = constructScript(etching, undefined, null, null);

      // getting the wallet balance
      let wallet = JSON.parse(fs.readFileSync(WALLET_PATH));
      let balance = wallet.utxos.reduce((acc, curr) => acc + curr.satoshis, 0);
      if (balance == 0) throw new Error("no funds");

      // creating new tx
      let tx = new Transaction();

      // first output carries the protocol message
      tx.addOutput(
        new dogecore.Transaction.Output({ script: script, satoshis: 0 })
      );

      // Create second output to sender if dunes are directly allocated in etching
      if (premine > 0) tx.to(wallet.address, 100_000);

      await fund(wallet, tx);

      await broadcast(tx, true);

      console.log(tx.hash);
    }
  );

async function parseScriptString(scriptString) {
  const parts = scriptString.split(" ");

  // Check if there is an OP_RETURN contained in the script string
  if (parts.indexOf("OP_RETURN") === -1) {
    throw new Error("No OP_RETURN output");
  }

  // Find the indices of the 'OP_PUSHBYTES' instructions
  const pushBytesIndices = parts.reduce((indices, part, index) => {
    if (part.startsWith("OP_PUSHBYTES")) {
      indices.push(index + 1);
    }
    return indices;
  }, []);

  // If 'OP_PUSHBYTES' not found, assume we got 'OP_RETURN identifier msg' format
  if (pushBytesIndices.length < 2) {
    pushBytesIndices.push(1);
    pushBytesIndices.push(2);
  }

  // Extract identifier and message
  const identifier = parts[pushBytesIndices[0]];

  /**
   * Check Protocol Identifier
   * Ord and most other explorers show this in hex representation.
   * Some explorers show this in decimal representation,
   * therefore we check both.
   **/
  if (identifier != IDENTIFIER) {
    if (parseInt(identifier, 16) != IDENTIFIER) {
      throw new Error("Couldn't find correct Protocol Identifier.");
    }
  }

  const msg = parts[pushBytesIndices[1]];

  // Parse msg to payload bytes
  const payload = [];
  for (let i = 0; i < msg.length; i += 2) {
    payload.push(parseInt(msg.substr(i, 2), 16));
  }

  return payload;
}

async function decodePayload(payload) {
  const integers = [];
  let i = 0;

  while (i < payload.length) {
    const [integer, length] = varIntDecode(payload.slice(i));
    integers.push(integer);
    i += length;
  }

  return integers;
}

function varIntDecode(buffer) {
  let n = 0n;
  let i = 0;

  while (true) {
    if (i < buffer.length) {
      const b = BigInt(parseInt(buffer[i], 10));
      n = n * 128n;

      if (b < 128) {
        return [n + b, i + 1];
      }

      n = n + b - 127n;

      i++;
    } else {
      return [n, i];
    }
  }
}

function parseIntegers(integers) {
  const edicts = [];
  const fields = {};

  for (let i = 0; i < integers.length; i += 2) {
    const tag = integers[i];
    if (tag === BigInt(Tag.Body)) {
      let id = 0n;
      for (let j = i + 1; j < integers.length; j += 3) {
        const chunk = integers.slice(j, j + 3);
        id = id + BigInt(parseInt(chunk[0], 10));
        edicts.push({
          id,
          amount: chunk[1],
          output: chunk[2],
        });
      }
      break;
    }

    if (i + 1 <= integers.length) {
      const value = integers[i + 1];
      if (!fields[tag]) fields[tag] = value;
    } else {
      break;
    }
  }

  return { fields, edicts };
}

function writeDuneWithSpacers(dune, spacers) {
  let output = "";

  for (let i = 0n; i < dune.length; i++) {
    const c = dune[i];
    output += c;

    if (spacers && i < dune.length - 1 && spacers & (1n << i)) {
      output += "•";
    }
  }

  return output;
}

// todo: this needs an update for the protocol changes
program
  .command("decodeDunesScript")
  .description("Decode an OP_RETURN Dunes Script")
  .argument("<script>", "Script from OP_RETURN output in tx")
  .action(async (script) => {
    const payload = await parseScriptString(script);
    const payloadIntegers = await decodePayload(payload);
    const { fields, edicts } = parseIntegers(payloadIntegers);

    let flags = Tag.take(Tag.Flags, fields);
    if (flags === undefined) flags = 0n;

    let isMintable = Flag.take(Flag.Terms, flags);
    let cenotaph = Flag.take(Flag.Cenotaph, flags);
    let isEtching = Flag.take(Flag.Etch, flags);

    // Show if this transaction burns dunes
    if (cenotaph) console.log("Dunes burning");

    // Show Etching if there is one
    if (isEtching) {
      let deadline = Tag.take(Tag.Deadline, fields);
      let default_output = Tag.take(Tag.Pointer, fields);
      let divisibility = Tag.take(Tag.Divisibility, fields);
      let limit = Tag.take(Tag.Limit, fields);
      let dune = Tag.take(Tag.Dune, fields);
      let spacers = Tag.take(Tag.Spacers, fields);
      let symbol = Tag.take(Tag.Symbol, fields);
      let term = Tag.take(Tag.OffsetEnd, fields);

      // Parse dune value to Spaced Dune as String
      const minAtCurrentHeightObj = { _value: dune };
      format.call(minAtCurrentHeightObj, formatter);
      const spacedDuneStr = writeDuneWithSpacers(formatter.output, spacers);
      symbol = String.fromCodePoint(parseInt(symbol, 10));

      console.log(
        `Deployment of Dune\n${spacedDuneStr}\nMintable: ${isMintable}\nDeadline: ${deadline}\nTerm: ${term}\nLimit: ${limit}\nDivisibility: ${divisibility}\nDefault Output: ${default_output}\nSymbol: ${symbol}`
      );
    }

    // Show Mints if there are any
    if (edicts.length > 0) {
      const stringifiedArray = edicts.map((obj) => {
        return {
          id: obj.id.toString(),
          amount: obj.amount.toString(),
          output: obj.output.toString(),
        };
      });
      const jsonString = `Mints:\n${JSON.stringify(stringifiedArray, null, 2)}`;
      console.log(jsonString);
    }
  });

const createUnsignedEtchTxFromUtxo = (
  utxo,
  id,
  amountPerMint,
  receiver,
  senderWallet
) => {
  if (process.env.FEE_PER_KB) {
    Transaction.FEE_PER_KB = parseInt(process.env.FEE_PER_KB);
  } else {
    Transaction.FEE_PER_KB = 100_000_000;
  }
  const duneId = parseDuneId(id, true);
  const edicts = [new Edict(duneId, amountPerMint, 1)];
  const script = constructScript(null, undefined, null, edicts);

  let tx = new Transaction();
  tx.addOutput(
    new dogecore.Transaction.Output({ script: script, satoshis: 0 })
  );
  tx.to(receiver, 100_000);
  tx.from(utxo);
  tx.change(senderWallet.address);

  return tx;
};

program.action("getBlockCount").action(async () => {
  const res = await getblockcount();
  console.log(res.data.result);
});

// @warning: this method is not dune aware.. so the dunes on the wallet are in danger of being spend
program
  .command("batchMintDune")
  .argument("<id>", "id of the dune in format block:index e.g. 5927764:2")
  .argument(
    "<amountPerMint>",
    "amount to mint per mint - consider the divisibility. (0 takes the limit of the dune as amount)"
  )
  .argument("<amountOfMints>", "how often you want to mint")
  .argument("<receiver>", "address of the receiver")
  .action(async (id, amountPerMint, amountOfMints, receiver) => {
    let wallet = JSON.parse(fs.readFileSync(WALLET_PATH));

    if (amountPerMint == 0) {
      const { id_, divisibility, limit } = await getDune(id);
      amountPerMint = BigInt(limit) * BigInt(10 ** divisibility);
    }

    /** CALCULATE FEES PER MINT */
    // we calculate how much funds we need per mint. We take a random fake input for that
    const utxo = {
      txid: "52c086a5e206d44f562c1166a93ac1b2f8f95fe5c25d25f798de4228f0c26ff8",
      vout: 2,
      script: "76a914fe9c184fee58c13d13be8fccafaeb4ff6172b39088ac",
      satoshis: 10 * 1e8, // 10 doge
    };

    const exampleEtchTx = createUnsignedEtchTxFromUtxo(
      utxo,
      id,
      amountPerMint,
      receiver,
      wallet
    );

    const fee = exampleEtchTx.inputAmount - exampleEtchTx.outputAmount;

    // the total doge we need per mint is the fee, the output and a safety buffer of 1.5 doge so that the change is not taken as fee
    const totalDogeNeededPerMint = fee + 100_000 + 1.5 * 1e8;

    /** BALANCE CHECK */
    console.log("Checking balance...");
    let balance = wallet.utxos.reduce((acc, curr) => acc + curr.satoshis, 0);
    const fundingDemand = totalDogeNeededPerMint * amountOfMints + 10 * 1e8;
    if (balance < fundingDemand) {
      console.error(
        `Not enough funds. You need ${
          fundingDemand * 1e-8
        } doge but you only have ${balance * 1e-8} doge`
      );
      process.exit(1);
    }

    /** CREATING SPLIT TX */
    console.log("Creating split tx...");
    let splitTx = new Transaction();
    for (let i = 0; i < amountOfMints; i++) {
      splitTx.to(wallet.address, totalDogeNeededPerMint);
    }
    await fund(wallet, splitTx);

    /** CREATING THE ETCH TXS */
    const unsignedEtchingTxs = [];
    for ([i, splitUtxo] of splitTx.toObject().outputs.entries()) {
      console.log(`Creating etch tx ${i + 1} of ${amountOfMints}`);
      unsignedEtchingTxs.push(
        createUnsignedEtchTxFromUtxo(
          {
            ...splitUtxo,
            txid: splitTx.hash,
            vout: i,
          },
          id,
          amountPerMint,
          receiver,
          wallet
        ).sign(wallet.privkey)
      );
    }

    /** BROADCAST */
    try {
      console.log("Broadcasting split tx");
      await broadcast(splitTx, true);
      console.log("Broadcasting etch txs");
      for (const [j, tx] of unsignedEtchingTxs.entries()) {
        console.log(
          `Broadcasting ${j} of ${unsignedEtchingTxs.length} etch tx | ${tx.hash}`
        );
        await broadcast(tx, true);
        console.log(`Etch tx ${j} broadcasted`);
      }
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  });

const walletCommand = program
  .command("wallet")
  .description("Wallet operations");

walletCommand
  .command("new")
  .description("Create a new wallet")
  .action(() => {
    walletNew();
  });

walletCommand
  .command("sync")
  .description("Sync the wallet")
  .action(async () => {
    await walletSync();
  });

walletCommand
  .command("balance")
  .description("Check wallet balance")
  .action(() => {
    walletBalance();
  });

walletCommand
  .command("send")
  .description("Send funds from the wallet")
  .argument("<address>", "Receiver's address")
  .argument("<amount>", "Amount to send")
  .action(async (address, amount) => {
    await walletSend(address, amount);
  });

walletCommand
  .command("split")
  .description("Split the wallet balance")
  .argument("<splits>", "Number of splits")
  .action(async (splits) => {
    await walletSplit(splits);
  });

//
walletCommand
  .command("splitutxo")
  .description("Split dune allocation from one utxo to multiple utxos")
  .argument("<utxotxid>", "UTXO to split")
  .argument("<split>", "number of utxos to split")
  .argument("<ticker>", "ticker of dune to split")
  .action(async (utxotxid, split, ticker) => {
    await utxoSplit(utxotxid, split, ticker);
  });

async function main() {
  program.parse();
}
function walletNew() {
  if (!fs.existsSync(WALLET_PATH)) {
    const privateKey = new PrivateKey();
    const privkey = privateKey.toWIF();
    const address = privateKey.toAddress().toString();
    const json = { privkey, address, utxos: [] };
    fs.writeFileSync(WALLET_PATH, JSON.stringify(json, 0, 2));
    console.log("address", address);
  } else {
    throw new Error("wallet already exists");
  }
}

if (!process.env.UNSPENT_API) {
  throw new Error("UNSPENT_API not set");
}

const unspentApi = axios.create({
  baseURL: process.env.UNSPENT_API,
  timeout: 100_000,
});
axiosRetry(unspentApi, axiosRetryOptions);

async function fetchAllUnspentOutputs(walletAddress) {
  let page = 1; // Start from the first page
  let allUnspentOutputs = []; // Array to hold all unspent outputs
  let hasMoreData = true; // Flag to keep the loop running until no more data is available

  while (hasMoreData) {
    try {
      console.log(`Fetching unspent outputs for page ${page}...`);
      // Fetch data from the API for the given page
      const response = await unspentApi.get(`/${walletAddress}/${page}`);
      const outputs = response.data.unspent_outputs;

      // Check if the response contains any unspent outputs
      if (outputs && outputs.length > 0) {
        // Map and concatenate the current page's data to the total
        const mappedOutputs = outputs.map((output) => ({
          txid: output.tx_hash,
          vout: output.tx_output_n,
          script: output.script,
          satoshis: Number(output.value),
        }));

        allUnspentOutputs = allUnspentOutputs.concat(mappedOutputs);
        page++; // Increment the page number to fetch the next page
      } else {
        hasMoreData = false; // No more data to fetch, exit the loop
      }
    } catch (error) {
      console.error("Error fetching unspent outputs:", error);
      break; // Exit the loop in case of an error
    }
  }

  return allUnspentOutputs; // Return the collected unspent outputs
}

async function walletSync() {
  let wallet = JSON.parse(fs.readFileSync(WALLET_PATH));

  wallet.utxos = await fetchAllUnspentOutputs(wallet.address);

  fs.writeFileSync(WALLET_PATH, JSON.stringify(wallet, 0, 2));

  let balance = wallet.utxos.reduce((acc, curr) => acc + curr.satoshis, 0);

  console.log("balance", balance);
}

function walletBalance() {
  let wallet = JSON.parse(fs.readFileSync(WALLET_PATH));

  let balance = wallet.utxos.reduce((acc, curr) => acc + curr.satoshis, 0);

  console.log(wallet.address, balance);
}

async function walletSend(argAddress, argAmount) {
  let wallet = JSON.parse(fs.readFileSync(WALLET_PATH));

  let balance = wallet.utxos.reduce((acc, curr) => acc + curr.satoshis, 0);
  if (balance == 0) throw new Error("no funds to send");

  let receiver = new Address(argAddress);
  let amount = parseInt(argAmount);

  let tx = new Transaction();
  if (amount) {
    tx.to(receiver, amount);
    await fund(wallet, tx);
  } else {
    tx.from(wallet.utxos);
    tx.change(receiver);
    tx.sign(wallet.privkey);
  }

  await broadcast(tx, true);

  console.log(tx.hash);
}

async function walletSplit(splits) {
  let wallet = JSON.parse(fs.readFileSync(WALLET_PATH));

  let balance = wallet.utxos.reduce((acc, curr) => acc + curr.satoshis, 0);
  if (balance == 0) throw new Error("no funds to split");

  let tx = new Transaction();
  tx.from(wallet.utxos);
  for (let i = 0; i < splits - 1; i++) {
    tx.to(wallet.address, Math.floor(balance / splits));
  }
  tx.change(wallet.address);
  tx.sign(wallet.privkey);

  await broadcast(tx, true);

  console.log(tx.hash);
}

async function utxoSplit(utxotxid, split, ticker) {
  if (split > 12) {
    throw new Error("Can't split more than 12 ");
  }

  const wallet = JSON.parse(fs.readFileSync(WALLET_PATH));

  // same txids for utxo? even when dune was split?
  let selectedUtxo = wallet.utxos.find((utxo) => utxo.txid === utxotxid);

  if (!selectedUtxo) {
    throw new Error("cant find utxo");
  }

  // will get the dune balance to split
  const duneBalance = Number(await getDuneBalance(ticker, wallet.address));
  console.log("dune balance:", duneBalance);
  let balanceSplit = Math.trunc(duneBalance / split);
  let remainderSplit = duneBalance % split;

  const splitUtxos = [];

  for (let i = 1; i <= split; i++) {
    splitUtxos.push({
      txid: utxotxid,
      satoshis: balanceSplit,
    });
  }

  // give the remainder to first utxo
  if (remainderSplit) {
    splitUtxos[0].satoshis += remainderSplit;
  }

  console.log(
    "update reference utxo data. note: satoshis are the balance to be sent",
    splitUtxos
  );

  // next step just need to implement with  dogecore syntax
  // will send dunes to txid based on splitUtxos array
  // error "no dunes"  ?
  // utxo vout problem causing dune not found?
  try {
    await walletSendDunes(
      selectedUtxo.txid,
      selectedUtxo.vout,
      //dune
      ticker,
      //just followed the example in the documentation  for decimals
      8,
      // amountsAsArray just send the satoshis for entry in array
      splitUtxos.map((update) => update.satoshis),
      // addressesAsArray,
      [wallet.address]
    );
  } catch (error) {
    console.error(error);
    process.exit(1);
  }

  console.log("split success");
}

async function fund(wallet, tx, onlySafeUtxos = true) {
  // we get the utxos without dunes
  let utxosWithoutDunes;
  if (onlySafeUtxos) {
    utxosWithoutDunes = await getUtxosWithOutDunes();
  } else {
    utxosWithoutDunes = wallet.utxos;
  }

  // we sort the largest utxos first
  const sortedUtxos = utxosWithoutDunes.slice().sort((a, b) => {
    return b.satoshis - a.satoshis;
  });

  // we filter for utxos that are larger than 1 DOGE
  const largeUtxos = sortedUtxos.filter((utxo) => {
    return utxo.satoshis >= 1_000_000;
  });

  const outputSum = tx.outputs.reduce((acc, curr) => acc + curr.satoshis, 0);
  let isChangeAdded = false;
  let inputSumAdded = 0;

  for (const utxo of largeUtxos) {
    if (inputSumAdded >= outputSum + tx._estimateFee()) {
      break;
    }

    utxo.vout = Number(utxo.vout);
    utxo.satoshis = Number(utxo.satoshis);
    tx.from(utxo);
    delete tx._fee;

    tx.change(wallet.address);
    isChangeAdded = true;
    inputSumAdded += utxo.satoshis;
  }

  tx._fee = tx._estimateFee();
  tx.sign(wallet.privkey);

  if (!isChangeAdded) {
    throw new Error("no change output added");
  }

  if (tx.inputAmount < tx.outputAmount + tx.getFee()) {
    throw new Error("not enough (secure) funds");
  }
}

function updateWallet(wallet, tx) {
  wallet.utxos = wallet.utxos.filter((utxo) => {
    for (const input of tx.inputs) {
      if (
        input.prevTxId.toString("hex") == utxo.txid &&
        input.outputIndex == utxo.vout
      ) {
        return false;
      }
    }
    return true;
  });

  tx.outputs.forEach((output, vout) => {
    if (output.script.toAddress().toString() == wallet.address) {
      wallet.utxos.push({
        txid: tx.hash,
        vout,
        script: output.script.toHex(),
        satoshis: output.satoshis,
      });
    }
  });
}

async function getrawtx(tx) {
  console.log("tx");
  console.log(tx.toString());
  const body = {
    jsonrpc: "1.0",
    id: 0,
    method: "getrawtransaction",
    params: [tx.toString(), true],
  };

  const options = {
    auth: {
      username: process.env.NODE_RPC_USER,
      password: process.env.NODE_RPC_PASS,
    },
  };

  return await axios.post(process.env.NODE_RPC_URL, body, options);
}

async function getblockcount() {
  const body = {
    jsonrpc: "1.0",
    id: 0,
    method: "getblockcount",
    params: [],
  };

  const options = {
    auth: {
      username: process.env.NODE_RPC_USER,
      password: process.env.NODE_RPC_PASS,
    },
  };

  return await axios.post(process.env.NODE_RPC_URL, body, options);
}

async function broadcast(tx, retry) {
  const body = {
    jsonrpc: "1.0",
    id: 0,
    method: "sendrawtransaction",
    params: [tx.toString()],
  };

  const options = {
    auth: {
      username: process.env.NODE_RPC_USER,
      password: process.env.NODE_RPC_PASS,
    },
  };

  const makePostRequest = async () => {
    try {
      const res = await axios.post(process.env.NODE_RPC_URL, body, options);
      return res;
    } catch (error) {
      return await axios.post(
        process.env.FALLBACK_NODE_RPC_URL || process.env.NODE_RPC_URL,
        body,
        options
      );
    }
  };

  let res;
  while (true) {
    try {
      res = await retryAsync(async () => await makePostRequest(), 10, 30000);
      break;
    } catch (e) {
      if (!retry) throw e;
      let msg =
        e.response &&
        e.response.data &&
        e.response.data.error &&
        e.response.data.error.message;
      if (msg && msg.includes("too-long-mempool-chain")) {
        console.warn("retrying in 15 secs, too-long-mempool-chain");

        const blockRes = await getblockcount();

        console.log(`Block is ${blockRes.data.result}`);

        await new Promise((resolve) => setTimeout(resolve, 15000));
      } else {
        await walletSync();
        console.log(`Made a wallet sync for address ${wallet.address}`);
        throw e;
      }
    }
  }

  let wallet = JSON.parse(fs.readFileSync(WALLET_PATH));

  updateWallet(wallet, tx);

  fs.writeFileSync(WALLET_PATH, JSON.stringify(wallet, 0, 2));

  if (res) {
    return res.data;
  }
}

async function getDunesForUtxos(hashes) {
  const ordApi = axios.create({
    baseURL: process.env.ORD,
    timeout: 100_000,
  });

  try {
    const response = await ordApi.get(`/outputs/${hashes.join(",")}`);
    const parsed = response.data;

    const dunes = [];

    parsed.forEach((output) => {
      if (output.dunes.length > 0) {
        dunes.push({ dunes: output.dunes, utxo: output.txid });
      }
    }, []);

    return dunes;
  } catch (error) {
    console.error("Error fetching or parsing data:", error);
    throw error;
  }
}

async function getDunesForUtxo(outputHash) {
  const ordApi = axios.create({
    baseURL: process.env.ORD,
    timeout: 100_000,
  });

  try {
    const response = await ordApi.get(`/output/${outputHash}`);
    const html = response.data;
    const $ = cheerio.load(html);

    const dunes = [];
    $("table tr").each((index, element) => {
      if (index === 0) return; // Skip the header row

      const cells = $(element).find("td");
      if (cells.length === 2) {
        const dune = $(cells[0]).text().trim();
        const amountString = $(cells[1]).text().trim().split(" ")[0];
        const amount = amountString;
        dunes.push({ dune, amount, utxo: outputHash });
      }
    });

    return dunes;
  } catch (error) {
    console.error("Error fetching or parsing data:", error);
    throw error;
  }
}

async function getDune(dune) {
  const ordApi = axios.create({
    baseURL: process.env.ORD,
    timeout: 100_000,
  });

  try {
    // Making a GET request using axios
    const { data } = await ordApi.get(`dune/${dune}`);
    const $ = cheerio.load(data);

    // Extracting the information
    let id, divisibility, limit;
    $("dl dt").each((index, element) => {
      const label = $(element).text().trim();
      const value = $(element).next("dd").text().trim();

      if (label === "id") {
        id = value;
      } else if (label === "divisibility") {
        divisibility = value;
      } else if (label === "amount" || label === "limit") {
        limit = parseInt(value.replace(/\D/g, ""), 10);
      }
    });

    return { id, divisibility, limit };
  } catch (error) {
    console.error("Error fetching or parsing data:", error);
    throw error;
  }
}

async function retryAsync(operation, maxRetries, retryInterval) {
  try {
    // Attempt the operation and return the result if it succeeds
    return await operation();
  } catch (error) {
    console.error(`Error executing operation: ${error.message}`);

    // If there are no more retries left, throw the error
    if (maxRetries <= 0) {
      console.error(
        `Max retries exceeded (${maxRetries}), aborting operation.`
      );
      throw error;
    }

    // Wait for the specified retry interval before attempting the operation again
    console.log(`Retrying operation in ${retryInterval} ms...`);
    await new Promise((resolve) => setTimeout(resolve, retryInterval));

    // Recursively retry the operation with one less retry and return the result if it succeeds
    return await retryAsync(operation, maxRetries - 1, retryInterval);
  }
}

main().catch((e) => {
  let reason =
    e.response &&
    e.response.data &&
    e.response.data.error &&
    e.response.data.error.message;
  console.error(reason ? e.message + ":" + reason : e.message);
});
