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

dotenv.config();

const ordApi = axios.create({ baseURL: process.env.ORD, timeout: 100_000 });
axiosRetry(axios, {
  retries: 10,
  retryDelay: axiosRetry.exponentialDelay,
});
// add this line to enable retries on ordApi:
axiosRetry(ordApi, {
  retries: 10,
  retryDelay: axiosRetry.exponentialDelay,
});

if (process.env.TESTNET === "true") {
  dogecore.Networks.defaultNetwork = dogecore.Networks.testnet;
}

if (process.env.FEE_PER_KB) {
  Transaction.FEE_PER_KB = parseInt(process.env.FEE_PER_KB, 10);
} else {
  Transaction.FEE_PER_KB = 100_000_000;
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
    if (tag === Tag.Dune) payload.push(encodeToTuple(value));
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
    const m = Flag.mask(flag);
    const set = (flags & m) !== 0n;
    flags &= ~m;
    return set;
  }
  static set(flag, flags) {
    return flags | Flag.mask(flag);
  }
}

function constructScript(
  etching = null,
  pointer = undefined,
  cenotaph = null,
  edicts = []
) {
  const payload = [];

  if (etching) {
    let flags = Number(Flag.mask(Flag.Etch));
    if (etching.turbo) flags |= Number(Flag.mask(Flag.Turbo));
    if (etching.terms) flags |= Number(Flag.mask(Flag.Terms));
    Tag.encode(Tag.Flags, flags, payload);

    if (etching.dune) Tag.encode(Tag.Dune, etching.dune, payload);
    if (etching.terms) {
      if (etching.terms.limit) Tag.encode(Tag.Limit, etching.terms.limit, payload);
      if (etching.terms.cap) Tag.encode(Tag.Cap, etching.terms.cap, payload);
      if (etching.terms.offsetStart) Tag.encode(Tag.OffsetStart, etching.terms.offsetStart, payload);
      if (etching.terms.offsetEnd) Tag.encode(Tag.OffsetEnd, etching.terms.offsetEnd, payload);
      if (etching.terms.heightStart) Tag.encode(Tag.HeightStart, etching.terms.heightStart, payload);
      if (etching.terms.heightEnd) Tag.encode(Tag.HeightEnd, etching.terms.heightEnd, payload);
    }
    if (etching.divisibility !== 0) Tag.encode(Tag.Divisibility, etching.divisibility, payload);
    if (etching.spacers !== 0) Tag.encode(Tag.Spacers, etching.spacers, payload);
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
    let lastId = 0n;

    for (const edict of sortedEdicts) {
      payload.push(varIntEncode(edict.id - lastId));
      payload.push(varIntEncode(edict.amount));
      payload.push(varIntEncode(edict.output));
      lastId = edict.id;
    }
  }

  const script = new Script().add("OP_RETURN").add(Buffer.from(IDENTIFIER));
  const flattened = payload.flat();
  for (let i = 0; i < flattened.length; i += MAX_SCRIPT_ELEMENT_SIZE) {
    const chunk = flattened.slice(i, i + MAX_SCRIPT_ELEMENT_SIZE);
    script.add(Buffer.from(PushBytes.fromSliceUnchecked(chunk).asBytes()));
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
  let x = 0n;
  for (let i = 0; i < s.length; i++) {
    if (i > 0) x += 1n;
    x *= 26n;
    const c = s.charCodeAt(i);
    if (c >= 65 && c <= 90) x += BigInt(c - 65);
    else throw new Error(`Invalid character in dune name: ${s[i]}`);
  }
  return new Dune(x);
}

function spacedDunefromStr(s) {
  let dune = "";
  let spacers = 0;
  for (const c of s) {
    if (/[A-Z]/.test(c)) dune += c;
    else if (/[\u2022\u2023]/.test(c)) {
      const flag = 1 << (dune.length - 1);
      if ((spacers & flag) !== 0) throw new Error("double spacer");
      spacers |= flag;
    } else throw new Error("invalid character");
  }
  if (32 - Math.clz32(spacers) >= dune.length) throw new Error("trailing spacer");
  return new SpacedDune(dune, spacers);
}

class Edict {
  constructor(id, amount, output) {
    this.id = id;
    this.amount = amount;
    this.output = output;
  }
}

class Terms {
  constructor(limit, cap, offsetStart, offsetEnd, heightStart, heightEnd, price = null) {
    this.limit = limit !== undefined ? limit : null;
    this.cap = cap !== undefined ? cap : null;
    this.offsetStart = offsetStart !== undefined ? offsetStart : null;
    this.offsetEnd = offsetEnd !== undefined ? offsetEnd : null;
    this.heightStart = heightStart !== undefined ? heightStart : null;
    this.heightEnd = heightEnd !== undefined ? heightEnd : null;
    if (price) this.price = price;
  }
}

class Etching {
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
  const length = 12 - Math.floor(Number(progress / INTERVAL));
  const startValue = BigInt(STEPS[length]);
  const endValue = BigInt(STEPS[length - 1]);

  const remainder = progress % INTERVAL;
  return startValue - ((startValue - endValue) * remainder) / INTERVAL;
}

function encodeToTuple(n) {
  const tupleRepresentation = [];
  tupleRepresentation.push(Number(n & 0b01111111n));
  while (n > 0b01111111n) {
    n = n / 128n - 1n;
    tupleRepresentation.unshift(
      Number((n & 0b01111111n) | 0b10000000n)
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
    const CHUNK_SIZE = 10;

    async function processChunk(utxosChunk, startIndex) {
      const promises = utxosChunk.map((utxo, index) => {
        console.log(
          `Processing utxo number ${startIndex + index} of ${wallet.utxos.length}`
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
    const utxos = await fetchAllUnspentOutputs(address);
    let balance = 0n;
    const utxoHashes = utxos.map((utxo) => `${utxo.txid}:${utxo.vout}`);
    const chunkSize = 10;

    const chunkedUtxoHashes = [];
    for (let i = 0; i < utxoHashes.length; i += chunkSize) {
      chunkedUtxoHashes.push(utxoHashes.slice(i, i + chunkSize));
    }

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
  const regex1 = /^\d+\:\d+$/;
  const regex2 = /^\d+\/\d+$/;

  if (!regex1.test(id) && !regex2.test(id))
    console.log(
      `Dune ID ${id} is not in the expected format e.g. 1234:1 or 1234/1`
    );

  const [heightStr, indexStr] = regex1.test(id) ? id.split(":") : id.split("/");
  const height = BigInt(parseInt(heightStr, 10));
  const index = BigInt(parseInt(indexStr, 10));

  let duneId = (height << 16n) | index;
  if (claim) {
    const CLAIM_BIT = 1n << 48n;  
    duneId |= CLAIM_BIT;
  }

  return duneId;
};

const createScriptWithProtocolMsg = () => {
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
    const amountsAsArray = amounts.split(",").map((a) => Number(a));
    const addressesAsArray = addresses.split(",");
    if (amountsAsArray.length !== addressesAsArray.length) {
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
        parseInt(utxoAmount, 10),
        dune
      );
      console.info(`Broadcasted transaction: ${JSON.stringify(res)}`);
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  });

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
    (u) => u.txid === txhash && u.vout === parseInt(vout, 10)
  );
  if (!dune_utxo) throw new Error(`utxo ${txhash}:${vout} not found`);

  const dunes = await getDunesForUtxo(`${dune_utxo.txid}:${dune_utxo.vout}`);
  if (dunes.length === 0) throw new Error("no dunes");

  const duneOnUtxo = dunes.find((d) => d.dune === dune);
  if (!duneOnUtxo) throw new Error("dune not found");

  let duneOnUtxoAmount = BigInt(duneOnUtxo.amount.match(/\d+/)[0]);
  duneOnUtxoAmount *= BigInt(10 ** decimals);

  const totalAmount = amounts.reduce(
    (acc, curr) => acc + BigInt(curr),
    0n
  );

  if (duneOnUtxoAmount < totalAmount) throw new Error("not enough dunes");

  const response = await prompts({
    type: "confirm",
    name: "value",
    message: `Transferring ${totalAmount} of ${dune}. Proceed?`,
    initial: true,
  });
  if (!response.value) throw new Error("Transaction aborted");

  const DEFAULT_OUTPUT = 1;
  const OFFSET = 2;
  const edicts = amounts.map((amt, i) => new Edict(parseDuneId(dune), amt, i + OFFSET));

  const script = constructScript(null, DEFAULT_OUTPUT, null, edicts);
  const tx = new Transaction();
  tx.addOutput(new Transaction.Output({ script, satoshis: 0 }));
  tx.to(wallet.address, 100_000);
  for (const addr of addresses) tx.to(addr, 100_000);

  await fund(wallet, tx);
  if (tx.inputAmount < tx.outputAmount + tx.getFee()) throw new Error("not enough funds");

  await broadcast(tx, true);
  console.log(tx.hash);
}

async function walletSendDunesNoProtocol(address, utxoAmount, dune) {
  let wallet = JSON.parse(fs.readFileSync(WALLET_PATH));

  const walletBalanceFromOrd = await axios.get(
    `${process.env.ORD}dunes/balance/${wallet.address}?show_all=true`
  );

  const duneOutputMap = new Map();
  for (const d of walletBalanceFromOrd.data.dunes) {
    for (const b of d.balances) {
      duneOutputMap.set(b.txid, { ...b, dune: d.dune });
    }
  }

  const nonDuneUtxos = wallet.utxos.filter((u) => !duneOutputMap.has(u.txid));
  if (nonDuneUtxos.length === 0) throw new Error("no utxos without dunes found");

  const dunesUtxos = [];
  for (const u of wallet.utxos) {
    if (dunesUtxos.length >= utxoAmount) break;
    if (duneOutputMap.has(u.txid) && duneOutputMap.get(u.txid).dune === dune) {
      dunesUtxos.push(u);
    }
  }
  if (dunesUtxos.length < utxoAmount) throw new Error("not enough dune utxos found");

  const resp = await prompts({
    type: "confirm",
    name: "value",
    message: `Transferring ${utxoAmount} utxos of ${dune}. Proceed?`,
    initial: true,
  });
  if (!resp.value) throw new Error("Transaction aborted");

  const tx = new Transaction();
  tx.from(dunesUtxos);
  tx.to(address, dunesUtxos.reduce((acc, u) => acc + u.satoshis, 0));
  await fund(wallet, tx);
  return await broadcast(tx, true);
}

const _mintDune = async (id, amount, receiver) => {
  console.log("Minting Dune...", id, amount, receiver);
  const duneId = parseDuneId(id, true);

  if (amount === 0) {
    const { divisibility, limit } = await getDune(id);
    amount = BigInt(limit) * BigInt(10 ** divisibility);
  }

  const edicts = [new Edict(duneId, amount, 1)];
  const script = constructScript(null, undefined, null, edicts);
  let wallet = JSON.parse(fs.readFileSync(WALLET_PATH));
  if (wallet.utxos.length === 0) throw new Error("no funds");

  const tx = new Transaction();
  tx.addOutput(new Transaction.Output({ script, satoshis: 0 }));
  tx.to(receiver, 100_000);
  await fund(wallet, tx);

  await broadcast(tx, true).catch(console.log);
  console.log(tx.hash);
};

program
  .command("mintDune")
  .description("Mint a Dune")
  .argument("<id>", "block:index e.g. 5927764:2")
  .argument("<amount>", "amount to mint (0 uses limit)")
  .argument("<receiver>", "receiver address")
  .action(_mintDune);

function isSingleEmoji(str) {
  const emojiRegex = /[\p{Emoji}]/gu;
  const matches = str.match(emojiRegex);
  return matches ? matches.length === 1 : false;
}

program
  .command("deployOpenDune")
  .description("Deploy a Dune that is open for mint with optional parent inscription")
  .argument("<tick>", "Tick for the dune")
  .argument("<symbol>", "Symbol")
  .argument("<limit>", "Max mint per tx")
  .argument("<divisibility>", "Divisibility")
  .argument("<cap>", "Overall mint cap or 'null'")
  .argument("<heightStart>", "Open height or 'null'")
  .argument("<heightEnd>", "Close height or 'null'")
  .argument("<offsetStart>", "Open offset or 'null'")
  .argument("<offsetEnd>", "Close offset or 'null'")
  .argument("<premine>", "Premine amount or 'null'")
  .argument("<turbo>", "Turbo flag true/false")
  .argument("<openMint>", "Enable minting true/false")
  .argument("[parentId]", "Optional parent inscription ID")
  .argument("<priceAmount>", "Mint price in shibes or 'null'")
  .argument("<pricePayTo>", "Pay-to address or 'null'")
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
      openMint,
      parentId,
      priceAmount,
      pricePayTo
    ) => {
      console.log("Deploying open Dune with pay terms…");
      cap = cap === "null" ? null : cap;
      heightStart = heightStart === "null" ? null : heightStart;
      heightEnd = heightEnd === "null" ? null : heightEnd;
      offsetStart = offsetStart === "null" ? null : offsetStart;
      offsetEnd = offsetEnd === "null" ? null : offsetEnd;
      premine = premine === "null" ? null : premine;
      turbo = turbo === "true";
      openMint = openMint.toLowerCase() === "true";

      if (symbol && symbol.length !== 1 && !isSingleEmoji(symbol)) {
        console.error(`Error: Symbol must be 1 character, got '${symbol}'`);
        process.exit(1);
      }

      const spacedDune = spacedDunefromStr(tick);
      const { data: blockRes } = await getblockcount();
      const minAtCurrent = minimumAtHeight(blockRes.result);
      if (spacedDune.dune.value < minAtCurrent) {
        console.error("Dune characters are invalid at current height.");
        process.exit(1);
      }

      let price = null;
      if (priceAmount !== "null" && pricePayTo !== "null") {
        price = { amount: priceAmount, pay_to: pricePayTo };
      }

      const terms = openMint
        ? new Terms(limit, cap, offsetStart, offsetEnd, heightStart, heightEnd, price)
        : null;

      const etching = new Etching(
        divisibility,
        terms,
        turbo,
        premine,
        spacedDune.dune.value,
        spacedDune.spacers,
        symbol.codePointAt(0)
      );

      const script = constructScript(etching, undefined, null, null);

      const wallet = JSON.parse(fs.readFileSync(WALLET_PATH));
      let balance = wallet.utxos.reduce((a, c) => a + c.satoshis, 0);
      if (balance === 0) throw new Error("no funds");

      let tx = new Transaction();

      if (parentId) {
        const parentUtxo = await fetchParentUtxo(parentId);
        tx.from(parentUtxo);
        console.log(`Added parent UTXO ${parentId} to transaction`);
      }

      tx.addOutput(new Transaction.Output({ script, satoshis: 0 }));
      if (premine > 0) tx.to(wallet.address, 100_000);

      await fund(wallet, tx);

      if (tx.inputAmount < tx.outputAmount + tx.getFee()) {
        throw new Error("not enough funds to cover outputs and fee");
      }

      await broadcast(tx, true);
      console.log(`Dune deployed with tx hash: ${tx.hash}`);
    }
  );

// Helpers: fetchParentUtxo, getrawtx, getblockcount, broadcast, fund, updateWallet, fetchAllUnspentOutputs, getDunesForUtxos, getDunesForUtxo, getDune, retryAsync, wallet commands…

async function fetchParentUtxo(parentId) {
  const [txid, i] = parentId.split("i");
  const vout = parseInt(i, 10);
  const raw = await getrawtx(txid);
  const output = raw.data.result.vout[vout];
  return {
    txid,
    vout,
    script: output.scriptPubKey.hex,
    satoshis: Math.round(output.value * 1e8),
  };
}

async function getrawtx(txid) {
  const body = { jsonrpc: "1.0", id: 0, method: "getrawtransaction", params: [txid, true] };
  const opts = { auth: { username: process.env.NODE_RPC_USER, password: process.env.NODE_RPC_PASS } };
  return await axios.post(process.env.NODE_RPC_URL, body, opts);
}

async function getblockcount() {
  const body = { jsonrpc: "1.0", id: 0, method: "getblockcount", params: [] };
  const opts = { auth: { username: process.env.NODE_RPC_USER, password: process.env.NODE_RPC_PASS } };
  return await axios.post(process.env.NODE_RPC_URL, body, opts);
}

async function broadcast(tx, retry) {
  const body = { jsonrpc: "1.0", id: 0, method: "sendrawtransaction", params: [tx.toString()] };
  const opts = { auth: { username: process.env.NODE_RPC_USER, password: process.env.NODE_RPC_PASS } };
  const makePostRequest = async () => {
    try {
      return await axios.post(process.env.NODE_RPC_URL, body, opts);
    } catch {
      return await axios.post(process.env.FALLBACK_NODE_RPC_URL || process.env.NODE_RPC_URL, body, opts);
    }
  };
  let res;
  while (true) {
    try {
      res = await retryAsync(makePostRequest, 10, 30000);
      break;
    } catch (e) {
      if (!retry) throw e;
      const msg = e.response?.data?.error?.message;
      if (msg?.includes("too-long-mempool-chain")) {
        console.warn("retrying in 15 secs, too-long-mempool-chain");
        const blockRes = await getblockcount();
        console.log(`Block is ${blockRes.data.result}`);
        await new Promise((r) => setTimeout(r, 15000));
      } else {
        await walletSync();
        console.log(`Made a wallet sync for address ${JSON.parse(fs.readFileSync(WALLET_PATH)).address}`);
        throw e;
      }
    }
  }
  const wallet = JSON.parse(fs.readFileSync(WALLET_PATH));
  updateWallet(wallet, tx);
  fs.writeFileSync(WALLET_PATH, JSON.stringify(wallet, null, 2));
  return res.data;
}

async function fund(wallet, tx, onlySafeUtxos = true) {
  const utxos = onlySafeUtxos ? await getUtxosWithOutDunes() : wallet.utxos;
  const sorted = utxos.slice().sort((a, b) => b.satoshis - a.satoshis);
  const large = sorted.filter((u) => u.satoshis >= 1_000_000);
  const needed = tx.outputs.reduce((a, o) => a + o.satoshis, 0);
  let added = 0n, haveChange = false;
  for (const u of large) {
    if (added >= needed + BigInt(tx._estimateFee())) break;
    tx.from(u);
    delete tx._fee;
    tx.change(wallet.address);
    haveChange = true;
    added += BigInt(u.satoshis);
  }
  tx._fee = tx._estimateFee();
  tx.sign(wallet.privkey);
  if (!haveChange) throw new Error("no change output added");
  if (tx.inputAmount < tx.outputAmount + tx.getFee()) throw new Error("not enough (secure) funds");
}

function updateWallet(wallet, tx) {
  wallet.utxos = wallet.utxos.filter((u) =>
    !tx.inputs.some((i) => i.prevTxId.toString("hex") === u.txid && i.outputIndex === u.vout)
  );
  tx.outputs.forEach((out, idx) => {
    if (out.script.toAddress().toString() === wallet.address) {
      wallet.utxos.push({ txid: tx.hash, vout: idx, script: out.script.toHex(), satoshis: out.satoshis });
    }
  });
}

async function fetchAllUnspentOutputs(walletAddress) {
  const response = await ordApi.get(`utxos/balance/${walletAddress}?show_all=true&show_unsafe=true`);
  return (response.data.utxos || []).map((o) => ({ txid: o.txid, vout: o.vout, script: o.script, satoshis: Number(o.shibes) }));
}

async function getDunesForUtxos(hashes) {
  const response = await ordApi.get(`/outputs/${hashes.join(",")}`);
  return response.data.filter((o) => o.dunes.length > 0).map((o) => ({ dunes: o.dunes, utxo: o.txid }));
}

async function getDunesForUtxo(outputHash) {
  const html = await ordApi.get(`/output/${outputHash}`).then((r) => r.data);
  const $ = cheerio.load(html);
  const dunes = [];
  $("table tr").each((i, el) => {
    if (i === 0) return;
    const cells = $(el).find("td");
    if (cells.length === 2) {
      dunes.push({ dune: $(cells[0]).text().trim(), amount: $(cells[1]).text().trim().split(" ")[0], utxo: outputHash });
    }
  });
  return dunes;
}

async function getDune(dune) {
  const html = await ordApi.get(`dune/${dune}`).then((r) => r.data);
  const $ = cheerio.load(html);
  let id, divisibility, limit;
  $("dl dt").each((_, el) => {
    const label = $(el).text().trim();
    const value = $(el).next("dd").text().trim();
    if (label === "id") id = value;
    else if (label === "divisibility") divisibility = parseInt(value, 10);
    else if (label === "amount" || label === "limit") limit = parseInt(value.replace(/\D/g, ""), 10);
  });
  return { id, divisibility, limit };
}

async function retryAsync(operation, maxRetries, retryInterval) {
  try {
    return await operation();
  } catch (error) {
    if (maxRetries <= 0) throw error;
    console.log(`Retrying operation in ${retryInterval} ms...`);
    await new Promise((r) => setTimeout(r, retryInterval));
    return retryAsync(operation, maxRetries - 1, retryInterval);
  }
}

program
  .command("getBlockCount")
  .action(async () => {
    const res = await getblockcount();
    console.log(res.data.result);
  });

const walletCommand = program.command("wallet").description("Wallet operations");

walletCommand.command("new").description("Create a new wallet").action(walletNew);
walletCommand.command("sync").description("Sync the wallet").action(walletSync);
walletCommand.command("balance").description("Check wallet balance").action(walletBalance);
walletCommand.command("send").description("Send funds").argument("<address>").argument("<amount>").action(walletSend);
walletCommand.command("split").description("Split balance").argument("<splits>").action(walletSplit);

async function walletNew() {
  if (!fs.existsSync(WALLET_PATH)) {
    const privateKey = new PrivateKey();
    const privkey = privateKey.toWIF();
    const address = privateKey.toAddress().toString();
    fs.writeFileSync(WALLET_PATH, JSON.stringify({ privkey, address, utxos: [] }, null, 2));
    console.log("address", address);
  } else throw new Error("wallet already exists");
}

async function walletSync() {
  const wallet = JSON.parse(fs.readFileSync(WALLET_PATH));
  wallet.utxos = await fetchAllUnspentOutputs(wallet.address);
  fs.writeFileSync(WALLET_PATH, JSON.stringify(wallet, null, 2));
  console.log("balance", wallet.utxos.reduce((a, c) => a + c.satoshis, 0));
}

function walletBalance() {
  const wallet = JSON.parse(fs.readFileSync(WALLET_PATH));
  console.log(wallet.address, wallet.utxos.reduce((a, c) => a + c.satoshis, 0));
}

async function walletSend(argAddress, argAmount) {
  const wallet = JSON.parse(fs.readFileSync(WALLET_PATH));
  const balance = wallet.utxos.reduce((a, c) => a + c.satoshis, 0);
  if (balance === 0) throw new Error("no funds to send");

  const tx = new Transaction();
  if (parseInt(argAmount, 10)) {
    tx.to(new Address(argAddress), parseInt(argAmount, 10));
    await fund(wallet, tx);
  } else {
    tx.from(wallet.utxos);
    tx.change(new Address(argAddress));
    tx.sign(wallet.privkey);
  }

  await broadcast(tx, true);
  console.log(tx.hash);
}

async function walletSplit(splits) {
  const wallet = JSON.parse(fs.readFileSync(WALLET_PATH));
  const balance = wallet.utxos.reduce((a, c) => a + c.satoshis, 0);
  if (balance === 0) throw new Error("no funds to split");

  const tx = new Transaction();
  tx.from(wallet.utxos);
  for (let i = 0; i < splits - 1; i++) {
    tx.to(wallet.address, Math.floor(balance / splits));
  }
  tx.change(wallet.address).sign(wallet.privkey);

  await broadcast(tx, true);
  console.log(tx.hash);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
