const asyncAuto = require('async/auto');
const asyncRetry = require('async/retry');
const {authenticatedLndGrpc} = require('lightning');
const {getWalletInfo} = require('lightning/lnd_methods');
const {returnResult} = require('asyncjs-util');
const {unauthenticatedLndGrpc} = require('lightning');

const {dockerLndImage} = require('./constants');
const {spawnDockerImage} = require('./../docker');

const imageName = ver => !!ver ? `lightninglabs/lnd:${ver}` : dockerLndImage;
const interval = 100;
const macaroonPath = '/root/.lnd/data/chain/bitcoin/regtest/admin.macaroon';
const times = 500;
const tlsCertPath = '/root/.lnd/tls.cert';

/** Spawn a new Docker image running LND

  {
    bitcoind_rpc_host: <Bitcoin Core RPC Host String>
    bitcoind_rpc_pass: <Bitcoin Core RPC Password String>
    bitcoind_rpc_port: <Bitcoin Core RPC Port Number>
    bitcoind_rpc_user: <Bitcoin Core RPC Username String>
    bitcoind_zmq_block_port: <Bitcoin Core ZMQ Block Port Number>
    bitcoind_zmq_tx_port: <Bitcoin Core ZMQ Transaction Port Number>
    [configuration]: [<LND Configuration Argument String>]
    p2p_port: <LND Peer to Peer Listen Port Number>
    rpc_port: <LND RPC Port Number>
    tower_port: <LND Tower Port Number>
    [seed]: <Mnemonic Seed String>
  }

  @returns via cbk or Promise
  {
    cert: <LND Base64 Serialized TLS Cert>
    kill: ({}, [cbk]) => <Kill LND and Bitcoind Dockers Promise>
    macaroon: <LND Base64 Serialized Macaroon String>
    public_key: <LND Public Key Hex String>
    socket: <LND RPC Host:Port Network Address String>
    tower_socket: <LND Tower Socket Host:Port Network Address String>
  }
*/
module.exports = (args, cbk) => {
  return new Promise((resolve, reject) => {
    return asyncAuto({
      // Check arguments
      validate: cbk => {
        if (!args.bitcoind_rpc_pass) {
          return cbk([400, 'ExpectedBitcoinCoreRpcPasswordToSpawnLndDocker']);
        }

        if (!args.bitcoind_rpc_port) {
          return cbk([400, 'ExpectedBitcoinCoreRpcPortToSpawnLndDocker']);
        }

        if (!args.bitcoind_rpc_user) {
          return cbk([400, 'ExpectedBitcoinCoreRpcUserToSpawnLndDocker']);
        }

        if (!args.bitcoind_zmq_block_port) {
          return cbk([400, 'ExpectedBitcoinCoreZmqBlockPortToSpawnLndDocker']);
        }

        if (!args.bitcoind_zmq_tx_port) {
          return cbk([400, 'ExpectedBitcoinCoreZmqTxPortToSpawnLndDocker']);
        }

        if (!args.p2p_port) {
          return cbk([400, 'ExpectedLndPeer2PeerNetworkPortToSpawnLndDocker']);
        }

        if (!args.rpc_port) {
          return cbk([400, 'ExpectedRpcPortToSpawnLndDocker']);
        }

        if (!args.tower_port) {
          return cbk([400, 'ExpectedTowerPortToSpawnLndDocker']);
        }

        return cbk();
      },

      // Spin up the docker image
      spawnDocker: ['validate', ({}, cbk) => {
        const chainHost = args.bitcoind_rpc_host;
        const zmqBlockPort = args.bitcoind_zmq_block_port;
        const zmqTxPort = args.bitcoind_zmq_tx_port;

        const arguments = [
          '--accept-keysend',
          '--allow-circular-route',
          '--autopilot.heuristic=externalscore:0.5',
          '--autopilot.heuristic=preferential:0.5',
          '--bitcoin.active',
          '--bitcoin.minhtlc=1000',
          '--bitcoin.node=bitcoind',
          '--bitcoin.regtest',
          `--bitcoind.rpchost=${chainHost}:18443`,
          `--bitcoind.rpcpass=${args.bitcoind_rpc_pass}`,
          `--bitcoind.rpcuser=${args.bitcoind_rpc_user}`,
          `--bitcoind.zmqpubrawblock=tcp://${chainHost}:${zmqBlockPort}`,
          `--bitcoind.zmqpubrawtx=tcp://${chainHost}:${zmqTxPort}`,
          '--debuglevel=trace',
          `--externalip=127.0.0.1:9735`,
          '--historicalsyncinterval=1s',
          `--listen=0.0.0.0:9735`,
          '--nobootstrap',
          `--rpclisten=0.0.0.0:10009`,
          '--trickledelay=1',
          '--unsafe-disconnect',
          '--watchtower.externalip', `127.0.0.1:9911`,
          '--watchtower.listen', `127.0.0.1:9911`,
        ];

        return spawnDockerImage({
          arguments: arguments.concat(args.configuration || []),
          image: imageName(process.env.DOCKER_LND_VERSION),
          ports: {
            '9735/tcp': args.p2p_port,
            '9911/tcp': args.tower_port,
            '10009/tcp': args.rpc_port,
          },
        },
        cbk);
      }],

      // Get the certificate out of the docker image
      getCertificate: ['spawnDocker', ({spawnDocker}, cbk) => {
        return asyncRetry({interval, times}, cbk => {
          return spawnDocker.getFile({path: tlsCertPath}, cbk);
        },
        cbk);
      }],

      // Create a wallet for the LND
      createWallet: ['getCertificate', ({getCertificate}, cbk) => {
        const cert = getCertificate.file.toString('hex');
        const socket = `localhost:${args.rpc_port}`;

        const {lnd} = unauthenticatedLndGrpc({cert, socket});

        return asyncRetry({interval, times}, cbk => {
          return lnd.unlocker.genSeed({}, (err, res) => {
            if (!!err) {
              return cbk([503, 'UnexpectedErrorGeneratingSeed', {err}]);
            }

            const seed = res.cipher_seed_mnemonic.join(' ');

            lnd.unlocker.initWallet({
              cipher_seed_mnemonic: (args.seed || seed).split(' '),
              wallet_password: Buffer.from('password', 'utf8'),
            },
            (err, res) => {
              if (!!err) {
                return cbk([503, 'UnexpectedErrorInitializingWallet', {err}]);
              }

              return cbk(null, res.admin_macaroon);
            });
          });
        },
        cbk);
      }],

      // Wait for gRPC to respond
      waitForRpc: [
        'createWallet',
        'getCertificate',
        'spawnDocker',
        ({createWallet, getCertificate, spawnDocker}, cbk) =>
      {
        const {lnd} = authenticatedLndGrpc({
          cert: getCertificate.file.toString('hex'),
          macaroon: createWallet.toString('hex'),
          socket: `localhost:${args.rpc_port}`,
        });

        return asyncRetry({interval, times}, cbk => {
          return getWalletInfo({lnd}, cbk);
        },
        cbk);
      }],

      // LND fully spawned
      spawned: [
        'createWallet',
        'getCertificate',
        'spawnDocker',
        'waitForRpc',
        ({createWallet, getCertificate, spawnDocker, waitForRpc}, cbk) =>
      {
        return cbk(null, {
          cert: getCertificate.file.toString('base64'),
          host: spawnDocker.host,
          kill: spawnDocker.kill,
          macaroon: createWallet.toString('hex'),
          public_key: waitForRpc.public_key,
          socket: `localhost:${args.rpc_port}`,
          tower_socket: `localhost:${args.tower_port}`,
        });
      }],
    },
    returnResult({reject, resolve, of: 'spawned'}, cbk));
  });
};
