//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// MockUsdc
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const mockUsdcAbi = [
  {
    type: 'constructor',
    inputs: [
      { name: 'initialOwner', internalType: 'address', type: 'address' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'owner', internalType: 'address', type: 'address' },
      { name: 'spender', internalType: 'address', type: 'address' },
    ],
    name: 'allowance',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'spender', internalType: 'address', type: 'address' },
      { name: 'value', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'approve',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'account', internalType: 'address', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'decimals',
    outputs: [{ name: '', internalType: 'uint8', type: 'uint8' }],
    stateMutability: 'pure',
  },
  {
    type: 'function',
    inputs: [
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'amount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'mint',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'name',
    outputs: [{ name: '', internalType: 'string', type: 'string' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'owner',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'renounceOwnership',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'symbol',
    outputs: [{ name: '', internalType: 'string', type: 'string' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'totalSupply',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'value', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'transfer',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'from', internalType: 'address', type: 'address' },
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'value', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'transferFrom',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'newOwner', internalType: 'address', type: 'address' }],
    name: 'transferOwnership',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'owner',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'spender',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'value',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'Approval',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'previousOwner',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'newOwner',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
    ],
    name: 'OwnershipTransferred',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'from', internalType: 'address', type: 'address', indexed: true },
      { name: 'to', internalType: 'address', type: 'address', indexed: true },
      {
        name: 'value',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'Transfer',
  },
  {
    type: 'error',
    inputs: [
      { name: 'spender', internalType: 'address', type: 'address' },
      { name: 'allowance', internalType: 'uint256', type: 'uint256' },
      { name: 'needed', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'ERC20InsufficientAllowance',
  },
  {
    type: 'error',
    inputs: [
      { name: 'sender', internalType: 'address', type: 'address' },
      { name: 'balance', internalType: 'uint256', type: 'uint256' },
      { name: 'needed', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'ERC20InsufficientBalance',
  },
  {
    type: 'error',
    inputs: [{ name: 'approver', internalType: 'address', type: 'address' }],
    name: 'ERC20InvalidApprover',
  },
  {
    type: 'error',
    inputs: [{ name: 'receiver', internalType: 'address', type: 'address' }],
    name: 'ERC20InvalidReceiver',
  },
  {
    type: 'error',
    inputs: [{ name: 'sender', internalType: 'address', type: 'address' }],
    name: 'ERC20InvalidSender',
  },
  {
    type: 'error',
    inputs: [{ name: 'spender', internalType: 'address', type: 'address' }],
    name: 'ERC20InvalidSpender',
  },
  {
    type: 'error',
    inputs: [{ name: 'owner', internalType: 'address', type: 'address' }],
    name: 'OwnableInvalidOwner',
  },
  {
    type: 'error',
    inputs: [{ name: 'account', internalType: 'address', type: 'address' }],
    name: 'OwnableUnauthorizedAccount',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// MockUsdcFaucet
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const mockUsdcFaucetAbi = [
  {
    type: 'constructor',
    inputs: [
      { name: '_token', internalType: 'contract MockUsdc', type: 'address' },
      { name: '_dripAmount', internalType: 'uint256', type: 'uint256' },
      { name: '_cooldown', internalType: 'uint256', type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'cooldown',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'drip',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'dripAmount',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'address', type: 'address' }],
    name: 'lastDripAt',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'token',
    outputs: [{ name: '', internalType: 'contract MockUsdc', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'recipient',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'amount',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'Drip',
  },
  {
    type: 'error',
    inputs: [{ name: 'remaining', internalType: 'uint256', type: 'uint256' }],
    name: 'CooldownActive',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// PactCore
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const pactCoreAbi = [
  {
    type: 'constructor',
    inputs: [
      { name: '_admin', internalType: 'address', type: 'address' },
      {
        name: '_settlementAuthority',
        internalType: 'address',
        type: 'address',
      },
      { name: '_defaultTreasury', internalType: 'address', type: 'address' },
      {
        name: '_premiumToken',
        internalType: 'contract IERC20',
        type: 'address',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'MAX_BATCH_SIZE',
    outputs: [{ name: '', internalType: 'uint16', type: 'uint16' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'MAX_FEE_RECIPIENTS',
    outputs: [{ name: '', internalType: 'uint8', type: 'uint8' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'MAX_TOTAL_FEE_BPS',
    outputs: [{ name: '', internalType: 'uint16', type: 'uint16' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'MIN_PREMIUM',
    outputs: [{ name: '', internalType: 'uint96', type: 'uint96' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'admin',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'bytes16', type: 'bytes16' }],
    name: 'callStatus',
    outputs: [{ name: '', internalType: 'uint8', type: 'uint8' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'bytes16', type: 'bytes16' }],
    name: 'coveragePool',
    outputs: [
      { name: 'balance', internalType: 'uint128', type: 'uint128' },
      { name: 'totalDeposits', internalType: 'uint128', type: 'uint128' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'defaultTreasury',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'bytes16', type: 'bytes16' }],
    name: 'endpointConfig',
    outputs: [
      { name: 'agentTokenId', internalType: 'uint256', type: 'uint256' },
      { name: 'flatPremium', internalType: 'uint96', type: 'uint96' },
      { name: 'percentBps', internalType: 'uint16', type: 'uint16' },
      { name: 'imputedCost', internalType: 'uint96', type: 'uint96' },
      { name: 'latencySloMs', internalType: 'uint16', type: 'uint16' },
      { name: 'exposureCapPerHour', internalType: 'uint96', type: 'uint96' },
      { name: 'currentPeriodStart', internalType: 'uint64', type: 'uint64' },
      { name: 'currentPeriodRefunds', internalType: 'uint96', type: 'uint96' },
      { name: 'totalCalls', internalType: 'uint64', type: 'uint64' },
      { name: 'totalBreaches', internalType: 'uint64', type: 'uint64' },
      { name: 'totalPremiums', internalType: 'uint96', type: 'uint96' },
      { name: 'totalRefunds', internalType: 'uint96', type: 'uint96' },
      { name: 'lastUpdated', internalType: 'uint64', type: 'uint64' },
      { name: 'paused', internalType: 'bool', type: 'bool' },
      { name: 'exists', internalType: 'bool', type: 'bool' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '', internalType: 'bytes16', type: 'bytes16' },
      { name: '', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'feeRecipients',
    outputs: [
      {
        name: 'kind',
        internalType: 'enum PactCore.RecipientKind',
        type: 'uint8',
      },
      { name: 'destination', internalType: 'address', type: 'address' },
      { name: 'bps', internalType: 'uint16', type: 'uint16' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'slug', internalType: 'bytes16', type: 'bytes16' },
      { name: 'paused_', internalType: 'bool', type: 'bool' },
    ],
    name: 'pauseEndpoint',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'paused_', internalType: 'bool', type: 'bool' }],
    name: 'pauseProtocol',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'premiumToken',
    outputs: [{ name: '', internalType: 'contract IERC20', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'protocolPaused',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '', internalType: 'bytes16', type: 'bytes16' },
      { name: '', internalType: 'address', type: 'address' },
    ],
    name: 'recipientEarnings',
    outputs: [{ name: '', internalType: 'uint128', type: 'uint128' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'slug', internalType: 'bytes16', type: 'bytes16' },
      {
        name: 'cfg',
        internalType: 'struct PactCore.EndpointConfig',
        type: 'tuple',
        components: [
          { name: 'agentTokenId', internalType: 'uint256', type: 'uint256' },
          { name: 'flatPremium', internalType: 'uint96', type: 'uint96' },
          { name: 'percentBps', internalType: 'uint16', type: 'uint16' },
          { name: 'imputedCost', internalType: 'uint96', type: 'uint96' },
          { name: 'latencySloMs', internalType: 'uint16', type: 'uint16' },
          {
            name: 'exposureCapPerHour',
            internalType: 'uint96',
            type: 'uint96',
          },
          {
            name: 'currentPeriodStart',
            internalType: 'uint64',
            type: 'uint64',
          },
          {
            name: 'currentPeriodRefunds',
            internalType: 'uint96',
            type: 'uint96',
          },
          { name: 'totalCalls', internalType: 'uint64', type: 'uint64' },
          { name: 'totalBreaches', internalType: 'uint64', type: 'uint64' },
          { name: 'totalPremiums', internalType: 'uint96', type: 'uint96' },
          { name: 'totalRefunds', internalType: 'uint96', type: 'uint96' },
          { name: 'lastUpdated', internalType: 'uint64', type: 'uint64' },
          { name: 'paused', internalType: 'bool', type: 'bool' },
          { name: 'exists', internalType: 'bool', type: 'bool' },
        ],
      },
      {
        name: 'recipients',
        internalType: 'struct PactCore.FeeRecipient[]',
        type: 'tuple[]',
        components: [
          {
            name: 'kind',
            internalType: 'enum PactCore.RecipientKind',
            type: 'uint8',
          },
          { name: 'destination', internalType: 'address', type: 'address' },
          { name: 'bps', internalType: 'uint16', type: 'uint16' },
        ],
      },
    ],
    name: 'registerEndpoint',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      {
        name: 'records',
        internalType: 'struct PactCore.SettlementRecord[]',
        type: 'tuple[]',
        components: [
          { name: 'callId', internalType: 'bytes16', type: 'bytes16' },
          { name: 'slug', internalType: 'bytes16', type: 'bytes16' },
          { name: 'agent', internalType: 'address', type: 'address' },
          { name: 'breach', internalType: 'bool', type: 'bool' },
          { name: 'premiumWei', internalType: 'uint96', type: 'uint96' },
          { name: 'refundWei', internalType: 'uint96', type: 'uint96' },
          { name: 'timestamp', internalType: 'uint64', type: 'uint64' },
          { name: 'rootHash', internalType: 'bytes32', type: 'bytes32' },
        ],
      },
    ],
    name: 'settleBatch',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'settlementAuthority',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'slug', internalType: 'bytes16', type: 'bytes16' },
      { name: 'amount', internalType: 'uint128', type: 'uint128' },
    ],
    name: 'topUpCoveragePool',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'slug', internalType: 'bytes16', type: 'bytes16' },
      {
        name: 'upd',
        internalType: 'struct PactCore.EndpointConfigUpdate',
        type: 'tuple',
        components: [
          { name: 'setAgentTokenId', internalType: 'bool', type: 'bool' },
          { name: 'agentTokenId', internalType: 'uint256', type: 'uint256' },
          { name: 'setFlatPremium', internalType: 'bool', type: 'bool' },
          { name: 'flatPremium', internalType: 'uint96', type: 'uint96' },
          { name: 'setPercentBps', internalType: 'bool', type: 'bool' },
          { name: 'percentBps', internalType: 'uint16', type: 'uint16' },
          { name: 'setImputedCost', internalType: 'bool', type: 'bool' },
          { name: 'imputedCost', internalType: 'uint96', type: 'uint96' },
          { name: 'setLatencySloMs', internalType: 'bool', type: 'bool' },
          { name: 'latencySloMs', internalType: 'uint16', type: 'uint16' },
          { name: 'setExposureCapPerHour', internalType: 'bool', type: 'bool' },
          {
            name: 'exposureCapPerHour',
            internalType: 'uint96',
            type: 'uint96',
          },
        ],
      },
    ],
    name: 'updateEndpointConfig',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'slug', internalType: 'bytes16', type: 'bytes16' },
      {
        name: 'recipients',
        internalType: 'struct PactCore.FeeRecipient[]',
        type: 'tuple[]',
        components: [
          {
            name: 'kind',
            internalType: 'enum PactCore.RecipientKind',
            type: 'uint8',
          },
          { name: 'destination', internalType: 'address', type: 'address' },
          { name: 'bps', internalType: 'uint16', type: 'uint16' },
        ],
      },
    ],
    name: 'updateFeeRecipients',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'callId',
        internalType: 'bytes16',
        type: 'bytes16',
        indexed: true,
      },
      { name: 'slug', internalType: 'bytes16', type: 'bytes16', indexed: true },
      {
        name: 'agent',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'status',
        internalType: 'enum PactCore.SettlementStatus',
        type: 'uint8',
        indexed: false,
      },
      {
        name: 'premium',
        internalType: 'uint96',
        type: 'uint96',
        indexed: false,
      },
      {
        name: 'refund',
        internalType: 'uint96',
        type: 'uint96',
        indexed: false,
      },
      {
        name: 'actualRefund',
        internalType: 'uint96',
        type: 'uint96',
        indexed: false,
      },
      {
        name: 'rootHash',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: false,
      },
    ],
    name: 'CallSettled',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'slug', internalType: 'bytes16', type: 'bytes16', indexed: true },
    ],
    name: 'EndpointConfigUpdated',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'slug', internalType: 'bytes16', type: 'bytes16', indexed: true },
      { name: 'paused', internalType: 'bool', type: 'bool', indexed: false },
    ],
    name: 'EndpointPaused',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'slug', internalType: 'bytes16', type: 'bytes16', indexed: true },
      {
        name: 'agentTokenId',
        internalType: 'uint256',
        type: 'uint256',
        indexed: true,
      },
      {
        name: 'flatPremium',
        internalType: 'uint96',
        type: 'uint96',
        indexed: false,
      },
      {
        name: 'percentBps',
        internalType: 'uint16',
        type: 'uint16',
        indexed: false,
      },
      {
        name: 'imputedCost',
        internalType: 'uint96',
        type: 'uint96',
        indexed: false,
      },
      {
        name: 'latencySloMs',
        internalType: 'uint16',
        type: 'uint16',
        indexed: false,
      },
      {
        name: 'exposureCapPerHour',
        internalType: 'uint96',
        type: 'uint96',
        indexed: false,
      },
    ],
    name: 'EndpointRegistered',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'slug', internalType: 'bytes16', type: 'bytes16', indexed: true },
    ],
    name: 'FeeRecipientsUpdated',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'slug', internalType: 'bytes16', type: 'bytes16', indexed: true },
      {
        name: 'funder',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'amount',
        internalType: 'uint128',
        type: 'uint128',
        indexed: false,
      },
    ],
    name: 'PoolToppedUp',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'paused', internalType: 'bool', type: 'bool', indexed: false },
    ],
    name: 'ProtocolPaused',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'slug', internalType: 'bytes16', type: 'bytes16', indexed: true },
      {
        name: 'recipient',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'amount',
        internalType: 'uint128',
        type: 'uint128',
        indexed: false,
      },
    ],
    name: 'RecipientPaid',
  },
  { type: 'error', inputs: [], name: 'BatchTooLarge' },
  { type: 'error', inputs: [], name: 'BpsSumExceedsCap' },
  { type: 'error', inputs: [], name: 'DuplicateCallId' },
  { type: 'error', inputs: [], name: 'EndpointAlreadyExists' },
  { type: 'error', inputs: [], name: 'EndpointIsPaused' },
  { type: 'error', inputs: [], name: 'EndpointNotFound' },
  { type: 'error', inputs: [], name: 'InvalidFeeRecipients' },
  { type: 'error', inputs: [], name: 'InvalidSlug' },
  { type: 'error', inputs: [], name: 'InvalidTimestamp' },
  { type: 'error', inputs: [], name: 'PremiumTooSmall' },
  { type: 'error', inputs: [], name: 'ProtocolIsPaused' },
  { type: 'error', inputs: [], name: 'ReentrancyGuardReentrantCall' },
  {
    type: 'error',
    inputs: [{ name: 'token', internalType: 'address', type: 'address' }],
    name: 'SafeERC20FailedOperation',
  },
  { type: 'error', inputs: [], name: 'TreasuryBpsZero' },
  { type: 'error', inputs: [], name: 'TreasuryCardinalityViolation' },
  { type: 'error', inputs: [], name: 'Unauthorized' },
] as const
