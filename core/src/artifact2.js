// Generado por scripts/compile.mjs a partir de contracts/VaultNotary2.sol. No editar a mano.
export const NOTARY2_ARTIFACT = {
  "compiler": "0.8.38+commit.1835d247.Emscripten.clang",
  "sourceSha256": "b2ad8984778b5fa06f47f6e3d81a9e547c7910dbe9fccb28f5aa5c3ea3ee3286",
  "abi": [
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
      "stateMutability": "nonpayable",
      "type": "constructor"
    },
    {
      "inputs": [
        {
          "internalType": "int64",
          "name": "responseCode",
          "type": "int64"
        }
      ],
      "name": "AuthorizeFailed",
      "type": "error"
    },
    {
      "inputs": [
        {
          "internalType": "enum VaultNotary2.Status",
          "name": "current",
          "type": "uint8"
        }
      ],
      "name": "BadStatus",
      "type": "error"
    },
    {
      "inputs": [
        {
          "internalType": "uint64",
          "name": "withdrawDelay",
          "type": "uint64"
        },
        {
          "internalType": "uint64",
          "name": "recoveryDelay",
          "type": "uint64"
        }
      ],
      "name": "InvalidDelay",
      "type": "error"
    },
    {
      "inputs": [],
      "name": "InvalidLane",
      "type": "error"
    },
    {
      "inputs": [
        {
          "internalType": "enum VaultNotary2.Lane",
          "name": "lane",
          "type": "uint8"
        },
        {
          "internalType": "uint64",
          "name": "until",
          "type": "uint64"
        }
      ],
      "name": "LaneLocked",
      "type": "error"
    },
    {
      "inputs": [
        {
          "internalType": "address",
          "name": "caller",
          "type": "address"
        }
      ],
      "name": "NotAllowed",
      "type": "error"
    },
    {
      "inputs": [
        {
          "internalType": "address",
          "name": "caller",
          "type": "address"
        }
      ],
      "name": "NotDevice",
      "type": "error"
    },
    {
      "inputs": [
        {
          "internalType": "address",
          "name": "caller",
          "type": "address"
        }
      ],
      "name": "NotRescue",
      "type": "error"
    },
    {
      "inputs": [],
      "name": "SameAddress",
      "type": "error"
    },
    {
      "inputs": [],
      "name": "Superseded",
      "type": "error"
    },
    {
      "inputs": [
        {
          "internalType": "uint64",
          "name": "executableAt",
          "type": "uint64"
        },
        {
          "internalType": "uint64",
          "name": "nowTs",
          "type": "uint64"
        }
      ],
      "name": "TooEarly",
      "type": "error"
    },
    {
      "inputs": [],
      "name": "ZeroAddress",
      "type": "error"
    },
    {
      "anonymous": false,
      "inputs": [
        {
          "indexed": true,
          "internalType": "address",
          "name": "schedule",
          "type": "address"
        },
        {
          "indexed": false,
          "internalType": "uint64",
          "name": "approvedAt",
          "type": "uint64"
        }
      ],
      "name": "Approved",
      "type": "event"
    },
    {
      "anonymous": false,
      "inputs": [
        {
          "indexed": true,
          "internalType": "enum VaultNotary2.Lane",
          "name": "lane",
          "type": "uint8"
        },
        {
          "indexed": true,
          "internalType": "address",
          "name": "by",
          "type": "address"
        },
        {
          "indexed": false,
          "internalType": "uint64",
          "name": "until",
          "type": "uint64"
        }
      ],
      "name": "Frozen",
      "type": "event"
    },
    {
      "anonymous": false,
      "inputs": [
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
        },
        {
          "indexed": false,
          "internalType": "address",
          "name": "guardian",
          "type": "address"
        },
        {
          "indexed": false,
          "internalType": "uint64",
          "name": "withdrawDelay",
          "type": "uint64"
        },
        {
          "indexed": false,
          "internalType": "uint64",
          "name": "recoveryDelay",
          "type": "uint64"
        }
      ],
      "name": "NotaryCreated",
      "type": "event"
    },
    {
      "anonymous": false,
      "inputs": [
        {
          "indexed": true,
          "internalType": "address",
          "name": "schedule",
          "type": "address"
        },
        {
          "indexed": false,
          "internalType": "enum VaultNotary2.Lane",
          "name": "lane",
          "type": "uint8"
        },
        {
          "indexed": false,
          "internalType": "uint64",
          "name": "requestedAt",
          "type": "uint64"
        },
        {
          "indexed": false,
          "internalType": "uint64",
          "name": "executableAt",
          "type": "uint64"
        }
      ],
      "name": "Requested",
      "type": "event"
    },
    {
      "anonymous": false,
      "inputs": [
        {
          "indexed": true,
          "internalType": "address",
          "name": "schedule",
          "type": "address"
        },
        {
          "indexed": true,
          "internalType": "address",
          "name": "by",
          "type": "address"
        }
      ],
      "name": "Vetoed",
      "type": "event"
    },
    {
      "inputs": [],
      "name": "MAX_DELAY",
      "outputs": [
        {
          "internalType": "uint64",
          "name": "",
          "type": "uint64"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [
        {
          "internalType": "address",
          "name": "schedule",
          "type": "address"
        }
      ],
      "name": "approve",
      "outputs": [],
      "stateMutability": "nonpayable",
      "type": "function"
    },
    {
      "inputs": [],
      "name": "device",
      "outputs": [
        {
          "internalType": "address",
          "name": "",
          "type": "address"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [
        {
          "internalType": "enum VaultNotary2.Lane",
          "name": "",
          "type": "uint8"
        }
      ],
      "name": "epochOf",
      "outputs": [
        {
          "internalType": "uint32",
          "name": "",
          "type": "uint32"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [
        {
          "internalType": "enum VaultNotary2.Lane",
          "name": "lane",
          "type": "uint8"
        }
      ],
      "name": "freeze",
      "outputs": [],
      "stateMutability": "nonpayable",
      "type": "function"
    },
    {
      "inputs": [],
      "name": "guardian",
      "outputs": [
        {
          "internalType": "address",
          "name": "",
          "type": "address"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [
        {
          "internalType": "enum VaultNotary2.Lane",
          "name": "",
          "type": "uint8"
        }
      ],
      "name": "lockedUntil",
      "outputs": [
        {
          "internalType": "uint64",
          "name": "",
          "type": "uint64"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [],
      "name": "recoveryDelay",
      "outputs": [
        {
          "internalType": "uint64",
          "name": "",
          "type": "uint64"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [
        {
          "internalType": "address",
          "name": "schedule",
          "type": "address"
        }
      ],
      "name": "request",
      "outputs": [],
      "stateMutability": "nonpayable",
      "type": "function"
    },
    {
      "inputs": [
        {
          "internalType": "address",
          "name": "schedule",
          "type": "address"
        }
      ],
      "name": "requestRecovery",
      "outputs": [],
      "stateMutability": "nonpayable",
      "type": "function"
    },
    {
      "inputs": [
        {
          "internalType": "address",
          "name": "",
          "type": "address"
        }
      ],
      "name": "requests",
      "outputs": [
        {
          "internalType": "enum VaultNotary2.Lane",
          "name": "lane",
          "type": "uint8"
        },
        {
          "internalType": "enum VaultNotary2.Status",
          "name": "status",
          "type": "uint8"
        },
        {
          "internalType": "uint32",
          "name": "epoch",
          "type": "uint32"
        },
        {
          "internalType": "uint64",
          "name": "requestedAt",
          "type": "uint64"
        },
        {
          "internalType": "uint64",
          "name": "executableAt",
          "type": "uint64"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [],
      "name": "rescue",
      "outputs": [
        {
          "internalType": "address",
          "name": "",
          "type": "address"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [
        {
          "internalType": "address",
          "name": "schedule",
          "type": "address"
        }
      ],
      "name": "statusOf",
      "outputs": [
        {
          "internalType": "enum VaultNotary2.Status",
          "name": "",
          "type": "uint8"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [
        {
          "internalType": "address",
          "name": "schedule",
          "type": "address"
        }
      ],
      "name": "veto",
      "outputs": [],
      "stateMutability": "nonpayable",
      "type": "function"
    },
    {
      "inputs": [],
      "name": "withdrawDelay",
      "outputs": [
        {
          "internalType": "uint64",
          "name": "",
          "type": "uint64"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    }
  ],
  "bytecode": "0x610120604052348015610010575f5ffd5b5060405161125438038061125483398101604081905261002f916101f9565b6001600160a01b038516158061004c57506001600160a01b038416155b1561006a5760405163d92e233d60e01b815260040160405180910390fd5b836001600160a01b0316856001600160a01b0316148061009b5750846001600160a01b0316836001600160a01b0316145b806100b75750836001600160a01b0316836001600160a01b0316145b156100d55760405163367558c360e01b815260040160405180910390fd5b6001600160401b03821615806100fc5750816001600160401b0316816001600160401b0316105b806101125750624f1a006001600160401b038216115b1561014757604051635ac4c70b60e01b81526001600160401b0380841660048301528216602482015260440160405180910390fd5b6001600160a01b03858116608081905285821660a081905291851660c08190526001600160401b0385811660e081905290851661010081905260408051938452602084019290925282820152517fe3388837bc939d478020e889e8404cdc404e8f92cb5eac89b4494937151acc9a9181900360600190a3505050505061025a565b80516001600160a01b03811681146101de575f5ffd5b919050565b80516001600160401b03811681146101de575f5ffd5b5f5f5f5f5f60a0868803121561020d575f5ffd5b610216866101c8565b9450610224602087016101c8565b9350610232604087016101c8565b9250610240606087016101e3565b915061024e608087016101e3565b90509295509295909350565b60805160a05160c05160e05161010051610f716102e35f395f81816101a40152818161052601526109f701525f818160f901528181610489015261054c01525f81816101d501528181610b050152610b3801525f818161013d015281816109af01528181610a370152610aca01525f81816102fa015281816104410152610a710152610f715ff3fe608060405234801561000f575f5ffd5b50600436106100f0575f3560e01c80635661b6e71161009357806397a5d5b51161006357806397a5d5b5146102d5578063c6326dd0146102f5578063daea85c51461031c578063e24ba2651461032f575f5ffd5b80635661b6e7146101f75780635ba297fc1461023157806374adad1d1461024457806376626b95146102ad575f5ffd5b806327c78c42116100ce57806327c78c421461018c5780633758ca7a1461019f5780634125ff90146101c6578063452a9320146101d0575f5ffd5b80630288a39c146100f45780631fbe19791461013857806326ae21a914610177575b5f5ffd5b61011b7f000000000000000000000000000000000000000000000000000000000000000081565b6040516001600160401b0390911681526020015b60405180910390f35b61015f7f000000000000000000000000000000000000000000000000000000000000000081565b6040516001600160a01b03909116815260200161012f565b61018a610185366004610d86565b610342565b005b61018a61019a366004610d86565b610436565b61011b7f000000000000000000000000000000000000000000000000000000000000000081565b61011b624f1a0081565b61015f7f000000000000000000000000000000000000000000000000000000000000000081565b61021c610205366004610db3565b60016020525f908152604090205463ffffffff1681565b60405163ffffffff909116815260200161012f565b61018a61023f366004610db3565b6104b0565b61029c610252366004610d86565b5f6020819052908152604090205460ff8082169161010081049091169063ffffffff62010000820416906001600160401b0366010000000000008204811691600160701b90041685565b60405161012f959493929190610e09565b61011b6102bb366004610db3565b60026020525f90815260409020546001600160401b031681565b6102e86102e3366004610d86565b61068c565b60405161012f9190610e50565b61015f7f000000000000000000000000000000000000000000000000000000000000000081565b61018a61032a366004610d86565b610736565b61018a61033d366004610d86565b6109a4565b6001600160a01b0381165f90815260208190526040902060018154610100900460ff16600381111561037657610376610dd1565b146103a857805460405163418f386d60e11b815261039f91610100900460ff1690600401610e50565b60405180910390fd5b80546103b79060ff1633610a1b565b1580156103d0575080546103ce9060ff1633610aae565b155b156103f05760405163fa5cd00f60e01b815233600482015260240161039f565b805461ff00191661020017815560405133906001600160a01b038416907fb2b2a7f649ab455f5c651de0476c23e874d1c01051ff5729280fa86ae462c9d4905f90a35050565b336001600160a01b037f0000000000000000000000000000000000000000000000000000000000000000161461048157604051630763a3b960e31b815233600482015260240161039f565b6104ad8160017f0000000000000000000000000000000000000000000000000000000000000000610b73565b50565b5f8160028111156104c3576104c3610dd1565b036104e157604051639885618760e01b815260040160405180910390fd5b6104eb8133610aae565b61050a5760405163fa5cd00f60e01b815233600482015260240161039f565b5f600182600281111561051f5761051f610dd1565b1461054a577f000000000000000000000000000000000000000000000000000000000000000061056c565b7f00000000000000000000000000000000000000000000000000000000000000005b6105769042610e72565b90506001805f84600281111561058e5761058e610dd1565b600281111561059f5761059f610dd1565b815260208101919091526040015f90812080549091906105c690849063ffffffff16610e91565b92506101000a81548163ffffffff021916908363ffffffff1602179055508060025f8460028111156105fa576105fa610dd1565b600281111561060b5761060b610dd1565b815260208101919091526040015f20805467ffffffffffffffff19166001600160401b03929092169190911790553382600281111561064c5761064c610dd1565b6040516001600160401b03841681527fc0fd6dd34301e9421c8a28a1b2b580d0278bb48b12754d3303710a0b4d0402009060200160405180910390a35050565b6001600160a01b0381165f90815260208190526040812060018154610100900460ff1660038111156106c0576106c0610dd1565b148015610719575080546001905f9060ff1660028111156106e3576106e3610dd1565b60028111156106f4576106f4610dd1565b815260208101919091526040015f2054815462010000900463ffffffff908116911614155b156107275750600292915050565b54610100900460ff1692915050565b6001600160a01b0381165f90815260208190526040902060018154610100900460ff16600381111561076a5761076a610dd1565b1461079357805460405163418f386d60e11b815261039f91610100900460ff1690600401610e50565b80546001905f9060ff1660028111156107ae576107ae610dd1565b60028111156107bf576107bf610dd1565b815260208101919091526040015f2054815462010000900463ffffffff9081169116146107ff5760405163b7ec7e4160e01b815260040160405180910390fd5b805442906001600160401b03600160701b9091048116908216101561085457815460405163cb6c86dd60e01b8152600160701b9091046001600160401b0390811660048301528216602482015260440161039f565b815461030061ff00199091161782556040516001600160a01b03841660248201525f90819061016b9060440160408051601f198184030181529181526020820180516001600160e01b031663f063796160e01b179052516108b59190610ead565b5f604051808303815f865af19150503d805f81146108ee576040519150601f19603f3d011682016040523d82523d5f602084013e6108f3565b606091505b50915091505f82801561090857506020825110155b610913576015610927565b818060200190518101906109279190610ec3565b9050600781900b60161461095457604051630f55d6c360e41b8152600782900b600482015260240161039f565b6040516001600160401b03851681526001600160a01b038716907f455a8fb9c223c9a3b58ac2b799d2646fc18c84f0a29737907bbf1ca854a3d556906020015b60405180910390a2505050505050565b336001600160a01b037f000000000000000000000000000000000000000000000000000000000000000016146109ef5760405163a7725be360e01b815233600482015260240161039f565b6104ad8160027f0000000000000000000000000000000000000000000000000000000000000000610b73565b5f6001836002811115610a3057610a30610dd1565b14610a6f577f00000000000000000000000000000000000000000000000000000000000000006001600160a01b0316826001600160a01b031614610aa5565b7f00000000000000000000000000000000000000000000000000000000000000006001600160a01b0316826001600160a01b0316145b90505b92915050565b5f6001836002811115610ac357610ac3610dd1565b03610a6f577f00000000000000000000000000000000000000000000000000000000000000006001600160a01b0316826001600160a01b03161480610b6c57507f00000000000000000000000000000000000000000000000000000000000000006001600160a01b031615801590610b6c57507f00000000000000000000000000000000000000000000000000000000000000006001600160a01b0316826001600160a01b0316145b9050610aa8565b6001600160a01b038316610b9a5760405163d92e233d60e01b815260040160405180910390fd5b425f6002818582811115610bb057610bb0610dd1565b6002811115610bc157610bc1610dd1565b815260208101919091526040015f20546001600160401b0390811691508216811115610c045783816040516301421f4960e71b815260040161039f929190610ee3565b6001600160a01b0385165f908152602081905260408120908154610100900460ff166003811115610c3757610c37610dd1565b14610c6057805460405163418f386d60e11b815261039f91610100900460ff1690600401610e50565b80548590829060ff19166001836002811115610c7e57610c7e610dd1565b0217905550805461ff00191661010017815560015f866002811115610ca557610ca5610dd1565b6002811115610cb657610cb6610dd1565b815260208101919091526040015f205481546dffffffffffffffffffffffff0000191663ffffffff90911662010000026dffffffffffffffff00000000000019161766010000000000006001600160401b03851602178155610d188484610e72565b815467ffffffffffffffff60701b1916600160701b6001600160401b039283168102919091178084556040516001600160a01b038a16937fe73303bb414d4a2f728bdbeb7de06e5b54de79fec32701dfd4123a00b33eaa6993610994938b938a939290910490911690610f07565b5f60208284031215610d96575f5ffd5b81356001600160a01b0381168114610dac575f5ffd5b9392505050565b5f60208284031215610dc3575f5ffd5b813560038110610dac575f5ffd5b634e487b7160e01b5f52602160045260245ffd5b60038110610df557610df5610dd1565b9052565b60048110610df557610df5610dd1565b60a08101610e178288610de5565b610e246020830187610df9565b63ffffffff9490941660408201526001600160401b039283166060820152911660809091015292915050565b60208101610aa88284610df9565b634e487b7160e01b5f52601160045260245ffd5b6001600160401b038181168382160190811115610aa857610aa8610e5e565b63ffffffff8181168382160190811115610aa857610aa8610e5e565b5f82518060208501845e5f920191825250919050565b5f60208284031215610ed3575f5ffd5b81518060070b8114610dac575f5ffd5b60408101610ef18285610de5565b6001600160401b03831660208301529392505050565b60608101610f158286610de5565b6001600160401b03841660208301526001600160401b038316604083015294935050505056fea26469706673582212206e96c0c425b0e445449b3414d083d71d9fed12b487b6292726f115bd76667a3064736f6c63430008260033"
};
