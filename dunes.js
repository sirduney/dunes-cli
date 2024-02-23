#!/usr/bin/env node

const dogecore = require("bitcore-lib-doge");
const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const dotenv = require("dotenv");
const { PrivateKey, Address, Transaction, Script, Opcode } = dogecore;
const { program } = require("commander");
const bb26 = require("base26");
const prompts = require("prompts");

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
  static Term = 8;
  static Deadline = 10;
  static DefaultOutput = 12;
  static Burn = 254;

  static Divisibility = 1;
  static Spacers = 3;
  static Symbol = 5;
  static Nop = 255;

  static take(tag, fields) {
    return fields.get(tag);
  }

  static encode(tag, value, payload) {
    payload.push(varIntEncode(tag));
    if (tag == Tag.Dune) payload.push(encodeToTuple(value));
    else payload.push(varIntEncode(value));
  }
}

class Flag {
  static Etch = 0;
  static Mint = 1;
  static Burn = 127;

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
  defaultOutput = undefined,
  burn = null,
  edicts = []
) {
  const payload = [];

  if (etching) {
    // Setting flags for etching and minting
    const flags = etching.mint
      ? Number(Flag.mask(Flag.Etch)) | Number(Flag.mask(Flag.Mint))
      : Number(Flag.mask(Flag.Etch));
    Tag.encode(Tag.Flags, flags, payload);
    if (etching.dune) Tag.encode(Tag.Dune, etching.dune, payload);
    if (etching.mint) {
      // don't include deadline right now
      //if (etching.mint.deadline) Tag.encode(Tag.Deadline, etching.mint.deadline, payload);
      if (etching.mint.limit)
        Tag.encode(Tag.Limit, etching.mint.limit, payload);
      if (etching.mint.term) Tag.encode(Tag.Term, etching.mint.term, payload);
    }
    if (etching.divisibility !== 0)
      Tag.encode(Tag.Divisibility, etching.divisibility, payload);
    if (etching.spacers !== 0)
      Tag.encode(Tag.Spacers, etching.spacers, payload);
    if (etching.symbol) Tag.encode(Tag.Symbol, etching.symbol, payload);
  }

  if (defaultOutput !== undefined) {
    Tag.encode(Tag.DefaultOutput, defaultOutput, payload);
  }

  if (burn) {
    Tag.encode(Tag.Burn, 0, payload);
  }

  if (edicts.length > 0) {
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

class Mint {
  constructor(deadline, limit, term) {
    this.deadline = deadline !== undefined ? deadline : null;
    this.limit = limit !== undefined ? limit : null;
    this.term = term !== undefined ? term : null;
  }
}

class Etching {
  // Constructor for Etching
  constructor(divisibility, mint, dune, spacers, symbol) {
    this.divisibility = divisibility;
    this.mint = mint !== undefined ? mint : null;
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
const FIRST_DUNE_HEIGHT = 5008400n;

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

  return formatter.end();
}

const formatter = {
  output: "",
  write(str) {
    this.output += str;
    return this;
  },
  end() {
    console.log(this.output);
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

program
  .command("printDunes")
  .description("Prints dunes of wallet")
  .action(async () => {
    let wallet = JSON.parse(fs.readFileSync(WALLET_PATH));
    const dunes = [];
    const getUtxosWithDunes = [];
    for (const [index, utxo] of wallet.utxos.entries()) {
      console.log(`Processing utxo number ${index} of ${wallet.utxos.length}`);
      const dunesOnUtxo = await getDunesForUtxo(`${utxo.txid}:${utxo.vout}`);
      dunes.push(...dunesOnUtxo);
      if (dunesOnUtxo.length > 0) {
        getUtxosWithDunes.push(utxo);
      }
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
    const utxos = await getAddressUtxos(address);
    let balance = 0n;
    let symbol;
    for (const [index, utxo] of utxos.entries()) {
      const dunesOnUtxo = await getDunesForUtxo(`${utxo.txid}:${utxo.vout}`);
      const amount = dunesOnUtxo
        .filter(({ dune }) => dune === dune_name)
        .map(({ amount }) => {
          symbol = amount.match(/[a-zA-Z▣]+/)[0];
          return BigInt(amount.match(/^(\d+)/)[1]);
        });
      if (amount > 0) balance += amount[0];
    }
    if (symbol) console.log(`${balance.toString()} ${symbol}`);
    else console.log(0);
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

  const safeUtxos = [];
  for (const [index, utxo] of wallet.utxos.entries()) {
    console.log(`Processing utxo number ${index} of ${wallet.utxos.length}`);
    const dunesOnUtxo = await getDunesForUtxo(`${utxo.txid}:${utxo.vout}`);
    if (dunesOnUtxo.length === 0) {
      safeUtxos.push(utxo);
    }
  }

  return safeUtxos;
};

const parseDuneId = (id, claim = false) => {
  // Check if Dune ID is in the expected format
  const regex = /^\d+\/\d+$/;
  if (!regex.test(id))
    console.log(`Dune ID ${id} is not in the expected format e.g. 1234/1`);

  // Parse the id string to get height and index
  const [heightStr, indexStr] = id.split("/");
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
      throw new Error(
        `length of amounts ${amountsAsArray.length} and addresses ${addressesAsArray.length} are different`
      );
    }
    await walletSendDunes(
      txhash,
      vout,
      dune,
      decimals,
      amountsAsArray,
      addressesAsArray
    );
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
  const { id, divisibility } = await getDune(dune);
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

program
  .command("mintDune")
  .description("Mint a Dune")
  .argument("<id>", "id of the dune in format block/index e.g. 5927764/2")
  .argument("<amount>", "amount to mint")
  .argument("<receiver>", "address of the receiver")
  .action(async (id, amount, receiver) => {
    console.log("Minting Dune...");
    console.log(id, amount, receiver);

    // Parse given id string to dune id
    const duneId = parseDuneId(id, true);

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

    await fund(wallet, tx, false);

    try {
      await broadcast(tx, true);
    } catch (e) {
      console.log(e);
    }

    console.log(tx.hash);
  });

program
  .command("deployOpenDune")
  .description("Deploy a Dune that is open for mint")
  .argument("<tick>", "Tick for the dune")
  .argument(
    "<term>",
    "Number of blocks after deployment that minting stays open"
  )
  .argument("<limit>", "Max limit that can be minted in one transaction")
  .argument("<deadline>", "Unix Timestamp up to which minting stays open")
  .argument("<divisibility>", "divisibility of the dune. Max 38")
  .argument("<symbol>", "symbol")
  .argument(
    "<mintAll>",
    "Mints the whole supply in one output if minting is disabled, else it mints the limit for one transaction"
  )
  .argument(
    "<openMint>",
    "Set this to true to allow minting, taking limit, deadline and term as restrictions"
  )
  .action(
    async (
      tick,
      term,
      limit,
      deadline,
      divisibility,
      symbol,
      mintAll,
      openMint
    ) => {
      console.log("Deploying open Dune...");
      console.log(
        tick,
        term,
        limit,
        deadline,
        divisibility,
        symbol,
        mintAll,
        openMint
      );

      mintAll = mintAll.toLowerCase() === "true";
      openMint = openMint.toLowerCase() === "true";

      // should also add a check for which dune length is allowed currently
      if (symbol && symbol.length != 1) {
        // Invalid Symbol
        console.error(
          `Error: The argument symbol should have exactly 1 character, but is '${symbol}'`
        );
        process.exit(1);
      }

      const spacedDune = spacedDunefromStr(tick);

      const blockcount = await getblockcount();
      const mininumAtCurrentHeight = minimumAtHeight(blockcount.data.result);

      if (spacedDune.dune.value < mininumAtCurrentHeight) {
        console.error("Dune characters are invalid at current height.");
        process.stdout.write(
          `minimum at current height: ${mininumAtCurrentHeight} possible lowest tick: `
        );
        const minAtCurrentHeightObj = { _value: mininumAtCurrentHeight };
        format.call(minAtCurrentHeightObj, formatter);
        console.log(`dune: ${tick} value: ${spacedDune.dune.value}`);
        process.exit(1);
      }

      const mint = openMint ? new Mint(deadline, limit, term) : null;

      // then there is no minting possible after deployment, just while deploying, so atm mintAll must be true then.
      const etching = new Etching(
        divisibility,
        mint,
        spacedDune.dune.value,
        spacedDune.spacers,
        symbol.charCodeAt(0)
      );

      // If mintAll is set, mint all dunes to output 1 of deployment transaction meaning that limit = max supply if minting is disabled
      const edicts = mintAll ? [new Edict(0, limit, 1)] : [];

      // create script for given dune statements
      const script = constructScript(etching, undefined, null, edicts);

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

      // Create second output to sender if all dunes are directly minted in deployment
      if (mintAll) tx.to(wallet.address, 100_000);

      await fund(wallet, tx);

      await broadcast(tx, true);

      console.log(tx.hash);
    }
  );

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

async function walletSync() {
  let wallet = JSON.parse(fs.readFileSync(WALLET_PATH));

  if (!process.env.UNSPENT_API) {
    throw new Error("UNSPENT_API not set");
  }

  const unspentApi = axios.create({
    baseURL: process.env.UNSPENT_API,
    timeout: 100_000,
  });

  let response = await unspentApi.get(`${wallet.address}`);

  wallet.utxos = response.data.unspent_outputs.map((output) => {
    return {
      txid: output.tx_hash,
      vout: output.tx_output_n,
      script: output.script,
      satoshis: Number(output.value),
    };
  });

  fs.writeFileSync(WALLET_PATH, JSON.stringify(wallet, 0, 2));

  let balance = wallet.utxos.reduce((acc, curr) => acc + curr.satoshis, 0);

  console.log("balance", balance);
}

async function getAddressUtxos(address) {
  if (!process.env.UNSPENT_API) {
    throw new Error("UNSPENT_API not set");
  }

  const unspentApi = axios.create({
    baseURL: process.env.UNSPENT_API,
    timeout: 100_000,
  });

  let response = await unspentApi.get(`${address}`);

  return response.data.unspent_outputs.map((output) => {
    return {
      txid: output.tx_hash,
      vout: output.tx_output_n,
      script: output.script,
      satoshis: Number(output.value),
    };
  });
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

async function fund(wallet, tx, onlySafeUtxos = true) {
  tx.change(wallet.address);
  delete tx._fee;

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

  for (const utxo of largeUtxos) {
    if (
      tx.inputs.length &&
      tx.outputs.length &&
      tx.inputAmount >= tx.outputAmount + tx.getFee() &&
      tx.inputAmount >= 1_500_000
    ) {
      break;
    }

    delete tx._fee;
    utxo.vout = Number(utxo.vout);
    utxo.satoshis = Number(utxo.satoshis);
    tx.from(utxo);
    tx.change(wallet.address);
    tx.sign(wallet.privkey);
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

  while (true) {
    try {
      await axios.post(process.env.NODE_RPC_URL, body, options);
      break;
    } catch (e) {
      if (!retry) throw e;
      let msg =
        e.response &&
        e.response.data &&
        e.response.data.error &&
        e.response.data.error.message;
      if (msg && msg.includes("too-long-mempool-chain")) {
        console.warn("retrying, too-long-mempool-chain");
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } else {
        throw e;
      }
    }
  }

  let wallet = JSON.parse(fs.readFileSync(WALLET_PATH));

  updateWallet(wallet, tx);

  fs.writeFileSync(WALLET_PATH, JSON.stringify(wallet, 0, 2));
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
    let id, divisibility;
    $("dl dt").each((index, element) => {
      const label = $(element).text().trim();
      const value = $(element).next("dd").text().trim();

      if (label === "id") {
        id = value;
      } else if (label === "divisibility") {
        divisibility = value;
      }
    });

    return { id, divisibility };
  } catch (error) {
    console.error("Error fetching or parsing data:", error);
    throw error;
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
