# Dunes

A minter and protocol for dunes on Dogecoin.

You can find general information about Dunes [here](./DUNES.md).

## ⚠️⚠️⚠️ Important ⚠️⚠️⚠️

Use this wallet for dunes only! Always mint from this wallet to a different address. This wallet is not meant for storing funds or dunes.

## Prerequisites

To use this, you'll need to use your console/terminal and install Node.js on your computer. So please ensure, that you have your

### Install NodeJS

Please head over to [https://nodejs.org/en/download](https://nodejs.org/en/download) and follow the installation instructions.

### Launch your own RPC

In order to inscribe, you will need to have access to a Dogecoin RPC. For example: [https://getblock.io/](https://getblock.io/) provides a service to get access to an RPC.
You will need that for the configuration.

## Setup

### git clone and install

Install by git clone (requires git and node on your computer)

#### git clone

```
git clone https://github.com/sirduney/dunes-cli.git
```

**or**

download this [zip file](https://github.com/verydogelabs/do20nals/archive/refs/heads/main.zip) and upack in a directory.

Now open your terminal and change to the directory the sources are installed.

```
cd <path to your download / installation>
npm install
```

After all dependencies are solved, you can configure the environment:

### Configure environment

Copy a `.env.example` to `.env` and add your node information. Here are also some recommended settings:

```
PROTOCOL_IDENTIFIER=D
NODE_RPC_URL=http://<ip>:<port>
# This is optional if you have an RPC from getblock.io
NODE_RPC_USER=<username>
NODE_RPC_PASS=<password>
TESTNET=false
FEE_PER_KB=500000000
UNSPENT_API=https://unspent.dogeord.io/api/v1/address/unspent/
ORD=https://wonky-ord.dogeord.io/
```

You can get the current fee per kb from [here](https://blockchair.com/).

## Funding

Generate a new `.wallet.json` file:

```
node dunes.js wallet new
```

Then send DOGE to the address displayed. Once sent, sync your wallet:

```
node dunes.js wallet sync
```

If you are minting a lot, you can split up your UTXOs:

```
node dunes.js wallet split <splits>
```

When you are done minting, send the funds back:

```
node dunes.js wallet send <address> <amount>
```

## Dunes

Deploy a dune:

```
node dunes.js deployOpenDune 'RANDOM•DUNE•NAME' <symbol> <limit-per-mint> <decimals> <max-nr-of-mints> <mint-absolute-start-block-height> <mint-absolute-stop-block-height> <mint-relative-start-block-height> <mint-relative-end-block-height> <amount-premined-to-deployer> <opt-in-for-future-protocol-changes> <minting-allowed>
```

Example for a dune that can be minted for 100 blocks, with a limit of 100000000, 8 decimals, no mint limit, symbol R (emojis also work) and premining 1R for the deployer during deployment. The `false` means the dune will not opt-in for future protocol changes. The `true` means mints are open.

The `null` means that the parameters won't be included, e.g. for not setting a max nr of mints limit. If absolute and relative block heights are defined, the dune minting terms will use the highest defined for start as the starting block height parameter and then lowest defined end as the ending block height.

```
node dunes.js deployOpenDune 'RANDOM•DUNE•NAME' 'R' 100000000 8 null null null null 100 100000000 false true
```

Mint a dune:

```
node dunes.js mintDune <id> <amount> <to>
```

Example:

```
node dunes.js mintDune '5088000:50' 100000000 DTZSTXecLmSXpRGSfht4tAMyqra1wsL7xb
```

Mass mint a dune:

```
node dunes.js batchMintDune <id> <amount> <number-of-mints> <to>
```

Example (this will do 100x mints):

```
node dunes.js batchMintDune '5088000:50' 100000000 100 DTZSTXecLmSXpRGSfht4tAMyqra1wsL7xb
```

Get the ID from: https://ord.dunesprotocol.com/dunes

Print the balance of an address:

```
node dunes.js printDuneBalance <dune-name> <address>
```

Example:

```
node dunes.js printDuneBalance WHO•LET•THE•DUNES•OUT DTZSTXecLmSXpRGSfht4tAMyqra1wsL7xb
```

Split dunes from one output to many:

```
node dunes.js sendDuneMulti <txhash> <vout> <dune> <decimals> <amounts> <addresses>
```

Example:

```
node dunes.js sendDuneMulti 15a0d646c03e52c3bf66d67c910caa9aa30e40ecf27f495f1b9c307a4ac09c2e 1 WHO•LET•THE•DUNES•OUT 8 2,3 DDjbkNTHPZAq3f6pzApDzP712V1xqSE2Ya,DTnBdk1evnpbKe1qeCoeATHZnAVtwNR2xe
```

Combine dunes from multiple outputs to one:

```
node dunes.js sendDunesNoProtocol <address> <utxo-amount> <dune>
```

Example:

```
node dunes.js sendDunesNoProtocol DDjbkNTHPZAq3f6pzApDzP712V1xqSE2Ya 10 WHO•LET•THE•DUNES•OUT
```

## FAQ

### I'm getting ECONNREFUSED errors when minting

There's a problem with the node connection. Your `dogecoin.conf` file should look something like:

```
rpcuser=ape
rpcpassword=zord
rpcport=22555
server=1
```

Make sure `port` is not set to the same number as `rpcport`. Also make sure `rpcauth` is not set.

Your `.env file` should look like:

```
NODE_RPC_URL=http://127.0.0.1:22555
NODE_RPC_USER=ape
NODE_RPC_PASS=zord
TESTNET=false
```

### I'm getting "insufficient priority" errors when minting

The miner fee is too low. You can increase it up by putting FEE_PER_KB=300000000 in your .env file or just wait it out. The default is 100000000 but spikes up when demand is high.
