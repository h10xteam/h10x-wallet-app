// Generado por scripts/compile.mjs a partir de contracts/NotaryFactory3.sol. No editar a mano.
export const FACTORY3_ARTIFACT = {
  "compiler": "0.8.38+commit.1835d247.Emscripten.clang",
  "sourceSha256": "dc4235448e2908fb5105807e09ad47a8b3119d0c6c7c3fa0c876ee80bb33d560",
  "abi": [
    {
      "anonymous": false,
      "inputs": [
        {
          "indexed": true,
          "internalType": "address",
          "name": "notary",
          "type": "address"
        },
        {
          "indexed": true,
          "internalType": "address",
          "name": "device",
          "type": "address"
        },
        {
          "indexed": true,
          "internalType": "address",
          "name": "rescue",
          "type": "address"
        }
      ],
      "name": "NotaryCreated",
      "type": "event"
    },
    {
      "inputs": [
        {
          "internalType": "address",
          "name": "device_",
          "type": "address"
        },
        {
          "internalType": "address",
          "name": "rescue_",
          "type": "address"
        },
        {
          "internalType": "address",
          "name": "guardian_",
          "type": "address"
        },
        {
          "internalType": "address",
          "name": "tiebreaker_",
          "type": "address"
        },
        {
          "internalType": "uint64",
          "name": "withdrawDelay_",
          "type": "uint64"
        },
        {
          "internalType": "uint64",
          "name": "recoveryDelay_",
          "type": "uint64"
        }
      ],
      "name": "create",
      "outputs": [
        {
          "internalType": "address",
          "name": "notary",
          "type": "address"
        }
      ],
      "stateMutability": "nonpayable",
      "type": "function"
    }
  ],
  "runtimeKeccak": "0x419da20ccdd3e2d79c8d6d5edfeb726799c24a47f3b422e7db59e5cf52c043ce"
};
