# Dunes

A minter and protocol for dunes on Dogecoin.

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

####

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
ORD=https://ord.dunesprotocol.com/
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
node dunes.js deployOpenDune 'RANDOM DUNE NAME' <blocks> <limit-per-mint> <timestamp-deadline> <decimals> <symbol> <mint-self> <is-open>
```

Example for a dune that can be minted for 100 blocks, with a limit of 100000000, a deadline of 0, 8 decimals, symbol R (emojis also work). First `true` value means 1R is minted during deploy. Second `true` means mints are open.

```
node dunes.js deployOpenDune 'RANDOM DUNE NAME' 100 100000000 0 8 R true true
```

Mint a dune:

```
node dunes.js mintDune <id> <amount> <to>
```

Example:

```
node dunes.js mintDune '5088000/50' 100000000 DTZSTXecLmSXpRGSfht4tAMyqra1wsL7xb
```

Mass mint a dune: 

```
node dunes.js batchMintDune <id> <amount> <number-of-mints> <to>
```

Example (this will do 100x mints):

```
node dunes.js batchMintDune '5088000/50' 100000000 100 DTZSTXecLmSXpRGSfht4tAMyqra1wsL7xb
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
