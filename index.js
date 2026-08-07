#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

// Pricing per million tokens (updated January 2025)
// Source: https://docs.anthropic.com/en/docs/about-claude/pricing
// Cache pricing: write = 1.25x input, read = 0.1x input
const PRICING = {
  // Claude 3 Haiku
  'claude-3-haiku': {
    input: 0.25,
    output: 1.25,
    cacheWrite: 0.30,  // 0.25 * 1.25
    cacheRead: 0.03    // 0.25 * 0.1
  },
  // Claude 3.5 Haiku
  'claude-3-5-haiku': {
    input: 0.80,
    output: 4.00,
    cacheWrite: 1.00,  // 0.80 * 1.25
    cacheRead: 0.08    // 0.80 * 0.1
  },
  // Claude 4.5 Haiku
  'claude-haiku-4-5': {
    input: 1.00,
    output: 5.00,
    cacheWrite: 1.25,  // 1.00 * 1.25
    cacheRead: 0.10    // 1.00 * 0.1
  },
  // Claude 3.5 Sonnet
  'claude-3-5-sonnet': {
    input: 3.00,
    output: 15.00,
    cacheWrite: 3.75,  // 3.00 * 1.25
    cacheRead: 0.30    // 3.00 * 0.1
  },
  // Claude 4.5 Sonnet
  'claude-sonnet-4-5': {
    input: 3.00,
    output: 15.00,
    cacheWrite: 3.75,  // 3.00 * 1.25
    cacheRead: 0.30    // 3.00 * 0.1
  },
  // Claude 4.1 Sonnet
  'claude-4-1-sonnet': {
    input: 5.00,
    output: 25.00,
    cacheWrite: 6.25,  // 5.00 * 1.25
    cacheRead: 0.50    // 5.00 * 0.1
  },
  // Claude Opus 4
  'claude-opus-4': {
    input: 15.00,
    output: 75.00,
    cacheWrite: 18.75,  // 15.00 * 1.25
    cacheRead: 1.50     // 15.00 * 0.1
  },
  // Default pricing (use 3.5 Sonnet as default)
  'default': {
    input: 3.00,
    output: 15.00,
    cacheWrite: 3.75,
    cacheRead: 0.30
  }
};

function getPricingForModel(modelId) {
  if (!modelId) return PRICING.default;

  const model = modelId.toLowerCase();

  // Match specific model versions
  if (model.includes('opus') && model.includes('4')) return PRICING['claude-opus-4'];
  if (model.includes('sonnet-4-5') || model.includes('sonnet-4.5')) return PRICING['claude-sonnet-4-5'];
  if (model.includes('haiku-4-5') || model.includes('haiku-4.5')) return PRICING['claude-haiku-4-5'];
  if (model.includes('sonnet') && model.includes('3.5')) return PRICING['claude-3-5-sonnet'];
  if (model.includes('haiku') && model.includes('3.5')) return PRICING['claude-3-5-haiku'];
  if (model.includes('haiku') && model.includes('3-haiku')) return PRICING['claude-3-haiku'];

  // Fallback for generic model names
  if (model.includes('opus')) return PRICING['claude-opus-4'];
  if (model.includes('sonnet')) return PRICING['claude-sonnet-4-5'];
  if (model.includes('haiku')) return PRICING['claude-haiku-4-5'];

  return PRICING.default;
}

function calculateCost(usage, pricing) {
  const inputCost = (usage.input_tokens || 0) * pricing.input / 1000000;
  const outputCost = (usage.output_tokens || 0) * pricing.output / 1000000;
  const cacheWriteCost = (usage.cache_creation_input_tokens || 0) * pricing.cacheWrite / 1000000;
  const cacheReadCost = (usage.cache_read_input_tokens || 0) * pricing.cacheRead / 1000000;

  return {
    input: inputCost,
    output: outputCost,
    cacheWrite: cacheWriteCost,
    cacheRead: cacheReadCost,
    total: inputCost + outputCost + cacheWriteCost + cacheReadCost
  };
}

function readJsonlFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n');
  return lines.map(line => JSON.parse(line));
}

function createFirefoxProfile(jsonlData) {
  // Filter out summary entries and get messages
  const messages = jsonlData.filter(entry =>
    entry.type === 'user' || entry.type === 'assistant'
  );

  if (messages.length === 0) {
    throw new Error('No messages found in the jsonl file');
  }

  // Get time range
  const timestamps = messages
    .map(msg => new Date(msg.timestamp).getTime())
    .sort((a, b) => a - b);

  const startTime = timestamps[0];
  const endTime = timestamps[timestamps.length - 1];

  // Create string table (for storing strings efficiently)
  const stringTable = new Map();
  const strings = [];

  function addString(str) {
    if (!stringTable.has(str)) {
      stringTable.set(str, strings.length);
      strings.push(str);
    }
    return stringTable.get(str);
  }

  // Pre-populate root string
  const rootStrIdx = addString('(root)');

  // Process messages and extract text content
  const messagesWithText = [];

  messages.forEach((msg) => {
    const role = msg.message?.role || msg.type;
    const content = msg.message?.content || '';
    const contentText = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map(c => c.text || '').join(' ').trim()
        : '';

    // Only include messages with actual text content
    if (contentText && contentText.length > 0) {
      messagesWithText.push({
        ...msg,
        role,
        contentText
      });
    }
  });

  if (messagesWithText.length === 0) {
    throw new Error('No messages with text content found in the jsonl file');
  }

  // Create markers for each message with text (correct format)
  const markers = {
    data: [],
    name: [],
    startTime: [],
    endTime: [],
    phase: [],
    category: [],
    length: 0
  };

  messagesWithText.forEach((msg) => {
    const timestamp = new Date(msg.timestamp).getTime();
    const relativeTime = timestamp - startTime;

    markers.name.push(addString(msg.role));
    markers.startTime.push(relativeTime);
    markers.endTime.push(relativeTime);
    markers.phase.push(0);  // 0 = instant marker
    markers.category.push(0);
    markers.data.push({
      type: 'Text',
      text: msg.contentText
    });
    markers.length++;
  });

  // Add separate token usage markers for messages with usage data
  const outputTokensNameIdx = addString('Output Tokens');
  const inputTokensNameIdx = addString('Input Tokens');
  const cacheReadTokensNameIdx = addString('Cache Read Tokens');
  const cacheCreationTokensNameIdx = addString('Cache Creation Tokens');
  const costNameIdx = addString('Cost ($)');
  const cumulativeCostNameIdx = addString('Cumulative Cost ($)');

  let cumulativeCost = 0;
  const seenRequestIds = new Set();

  // Aggregate tokens by model for accurate cost calculation
  const tokensByModel = new Map();

  messages.forEach((msg) => {
    const usage = msg.message?.usage;
    if (usage) {
      // Deduplicate by requestId - one requestId = one API call
      const requestId = msg.requestId;
      if (!requestId || seenRequestIds.has(requestId)) {
        return;
      }
      seenRequestIds.add(requestId);

      const modelId = msg.message?.model || 'unknown';

      if (!tokensByModel.has(modelId)) {
        tokensByModel.set(modelId, {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0
        });
      }

      const tokens = tokensByModel.get(modelId);
      tokens.input += usage.input_tokens || 0;
      tokens.output += usage.output_tokens || 0;
      tokens.cacheRead += usage.cache_read_input_tokens || 0;
      tokens.cacheWrite += usage.cache_creation_input_tokens || 0;
    }
  });

  // Calculate total cost from aggregated tokens
  for (const [modelId, tokens] of tokensByModel) {
    const pricing = getPricingForModel(modelId);
    const modelCost =
      tokens.input * pricing.input / 1000000 +
      tokens.output * pricing.output / 1000000 +
      tokens.cacheRead * pricing.cacheRead / 1000000 +
      tokens.cacheWrite * pricing.cacheWrite / 1000000;

    cumulativeCost += modelCost;
  }

  // Now create markers for each unique API call
  seenRequestIds.clear();
  let runningCost = 0;

  messages.forEach((msg) => {
    const usage = msg.message?.usage;
    if (usage) {
      // Deduplicate by requestId
      const requestId = msg.requestId;
      if (!requestId || seenRequestIds.has(requestId)) {
        return;
      }
      seenRequestIds.add(requestId);

      const modelId = msg.message?.model || 'unknown';
      const timestamp = new Date(msg.timestamp).getTime();
      const relativeTime = timestamp - startTime;

      // Get pricing for this model
      const pricing = getPricingForModel(modelId);
      const costs = calculateCost(usage, pricing);

      // Update running cost for cumulative chart
      runningCost += costs.total;

      // Create separate markers for each token type
      // Output tokens
      if (usage.output_tokens > 0) {
        markers.name.push(outputTokensNameIdx);
        markers.startTime.push(relativeTime);
        markers.endTime.push(relativeTime);
        markers.phase.push(0);  // 0 = instant marker
        markers.category.push(1);
        markers.data.push({
          type: 'OutputTokens',
          count: usage.output_tokens
        });
        markers.length++;
      }

      // Input tokens
      if (usage.input_tokens > 0) {
        markers.name.push(inputTokensNameIdx);
        markers.startTime.push(relativeTime);
        markers.endTime.push(relativeTime);
        markers.phase.push(0);
        markers.category.push(1);
        markers.data.push({
          type: 'InputTokens',
          count: usage.input_tokens
        });
        markers.length++;
      }

      // Cache read tokens
      if (usage.cache_read_input_tokens > 0) {
        markers.name.push(cacheReadTokensNameIdx);
        markers.startTime.push(relativeTime);
        markers.endTime.push(relativeTime);
        markers.phase.push(0);
        markers.category.push(1);
        markers.data.push({
          type: 'CacheReadTokens',
          count: usage.cache_read_input_tokens
        });
        markers.length++;
      }

      // Cache creation tokens
      if (usage.cache_creation_input_tokens > 0) {
        markers.name.push(cacheCreationTokensNameIdx);
        markers.startTime.push(relativeTime);
        markers.endTime.push(relativeTime);
        markers.phase.push(0);
        markers.category.push(1);
        markers.data.push({
          type: 'CacheCreationTokens',
          count: usage.cache_creation_input_tokens
        });
        markers.length++;
      }

      // Add cost marker
      if (costs.total > 0) {
        markers.name.push(costNameIdx);
        markers.startTime.push(relativeTime);
        markers.endTime.push(relativeTime);
        markers.phase.push(0);
        markers.category.push(1);
        markers.data.push({
          type: 'Cost',
          cost: costs.total,
          input: costs.input,
          output: costs.output,
          cacheWrite: costs.cacheWrite,
          cacheRead: costs.cacheRead
        });
        markers.length++;
      }

      // Add cumulative cost marker
      markers.name.push(cumulativeCostNameIdx);
      markers.startTime.push(relativeTime);
      markers.endTime.push(relativeTime);
      markers.phase.push(0);
      markers.category.push(1);
      markers.data.push({
        type: 'CumulativeCost',
        total: runningCost
      });
      markers.length++;
    }
  });

  // Create samples (one sample per message with text)
  const samples = {
    length: messagesWithText.length,
    stack: new Array(messagesWithText.length).fill(0),
    time: messagesWithText.map(msg => new Date(msg.timestamp).getTime() - startTime),
    weight: null,
    weightType: 'samples'
  };

  // Create stack table (simple: just one stack frame)
  const stackTable = {
    frame: [0],
    prefix: [null],
    category: [0],
    subcategory: [0],
    length: 1
  };

  // Create frame table
  const frameTable = {
    address: [-1],
    inlineDepth: [0],
    category: [null],
    subcategory: [0],
    func: [0],
    nativeSymbol: [null],
    innerWindowID: [0],
    implementation: [null],
    line: [null],
    column: [null],
    length: 1
  };

  // Create function table
  const funcTable = {
    name: [rootStrIdx],
    isJS: [false],
    relevantForJS: [false],
    resource: [-1],
    fileName: [null],
    lineNumber: [null],
    columnNumber: [null],
    length: 1
  };

  // Create resource table
  const resourceTable = {
    lib: [],
    name: [],
    host: [],
    type: [],
    length: 0
  };

  // Create categories
  const categories = [
    {
      name: 'Other',
      color: 'grey',
      subcategories: ['Other']
    },
    {
      name: 'Messages',
      color: 'blue',
      subcategories: ['Other']
    }
  ];

  // Marker schema for Text and separate Token Usage markers
  const markerSchema = [
    {
      name: 'Text',
      tooltipLabel: '{marker.name}',
      tableLabel: '{marker.data.text}',
      chartLabel: '{marker.name}',
      display: ['marker-chart', 'marker-table'],
      data: [
        {
          key: 'text',
          label: 'Content',
          format: 'string',
          searchable: true
        }
      ]
    },
    {
      name: 'OutputTokens',
      tooltipLabel: '{marker.name}',
      display: [],
      data: [
        {
          key: 'count',
          label: 'Output Tokens',
          format: 'integer'
        }
      ],
      graphs: [
        { key: 'count', color: 'blue', type: 'bar' }
      ]
    },
    {
      name: 'InputTokens',
      tooltipLabel: '{marker.name}',
      display: [],
      data: [
        {
          key: 'count',
          label: 'Input Tokens',
          format: 'integer'
        }
      ],
      graphs: [
        { key: 'count', color: 'green', type: 'bar' }
      ]
    },
    {
      name: 'CacheReadTokens',
      tooltipLabel: '{marker.name}',
      display: [],
      data: [
        {
          key: 'count',
          label: 'Cache Read Tokens',
          format: 'integer'
        }
      ],
      graphs: [
        { key: 'count', color: 'purple', type: 'bar' }
      ]
    },
    {
      name: 'CacheCreationTokens',
      tooltipLabel: '{marker.name}',
      display: [],
      data: [
        {
          key: 'count',
          label: 'Cache Creation Tokens',
          format: 'integer'
        }
      ],
      graphs: [
        { key: 'count', color: 'orange', type: 'bar' }
      ]
    },
    {
      name: 'Cost',
      tooltipLabel: '{marker.name}',
      display: [],
      data: [
        {
          key: 'cost',
          label: 'Cost',
          format: 'decimal'
        },
        {
          key: 'input',
          label: 'Input Cost',
          format: 'decimal'
        },
        {
          key: 'output',
          label: 'Output Cost',
          format: 'decimal'
        },
        {
          key: 'cacheWrite',
          label: 'Cache Write Cost',
          format: 'decimal'
        },
        {
          key: 'cacheRead',
          label: 'Cache Read Cost',
          format: 'decimal'
        }
      ],
      graphs: [
        { key: 'cost', color: 'red', type: 'bar' }
      ]
    },
    {
      name: 'CumulativeCost',
      tooltipLabel: '{marker.name}',
      display: [],
      data: [
        {
          key: 'total',
          label: 'Cumulative Cost',
          format: 'decimal'
        }
      ],
      graphs: [
        { key: 'total', color: 'red', type: 'line' }
      ]
    }
  ];

  // Create the main thread
  const thread = {
    processType: 'default',
    processName: 'Claude Conversation',
    processStartupTime: 0,
    processShutdownTime: null,
    registerTime: 0,
    unregisterTime: null,
    pausedRanges: [],
    showMarkersInTimeline: true,
    name: '',
    isMainThread: false,
    pid: '0',
    tid: 0,
    samples,
    markers,
    stackTable,
    frameTable,
    stringArray: strings,
    funcTable,
    resourceTable,
    nativeSymbols: {
      address: [],
      functionSize: [],
      libIndex: [],
      name: [],
      length: 0
    }
  };

  // Create the profile
  const profile = {
    meta: {
      processType: 0,
      product: 'Claude Code',
      stackwalk: 0,
      version: 27,
      preprocessedProfileVersion: 47,
      symbolicationNotSupported: true,
      interval: 1,
      startTime,
      profilingStartTime: 0,
      markerSchema,
      categories,
      usesOnlyOneStackType: true
    },
    libs: [],
    threads: [thread],
    counters: []
  };

  return profile;
}

function startServer(profileData) {
  return new Promise((resolve) => {
    let shutdownRequested = false;

    const server = http.createServer((req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': 'https://profiler.firefox.com'
      });
      res.end(JSON.stringify(profileData));
      shutdownRequested = true;
    });

    server.listen(0, 'localhost', () => {
      const { address, port } = server.address();
      const serverUrl = `http://${address}:${port}/`;
      resolve({ server, serverUrl, shutdownRequested: () => shutdownRequested });
    });
  });
}

async function openProfiler(serverUrl) {
  const profilerUrl = `https://profiler.firefox.com/from-url/${encodeURIComponent(serverUrl)}`;

  // Try to open with xdg-open on Linux, open on macOS, or start on Windows
  const command = process.platform === 'darwin' ? 'open' :
                  process.platform === 'win32' ? 'start' : 'xdg-open';

  try {
    spawn(command, [profilerUrl], { detached: true, stdio: 'ignore' }).unref();
    console.log(`Opening Firefox Profiler...`);
    console.log(`If the browser doesn't open, visit: ${profilerUrl}`);
  } catch (error) {
    console.log(`Please open this URL in a browser: ${profilerUrl}`);
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: claude-profiler <jsonl-file>');
    console.error('Example: claude-profiler ~/.claude/projects/my-session.jsonl');
    process.exit(1);
  }

  const filePath = args[0].startsWith('~')
    ? path.join(process.env.HOME, args[0].slice(1))
    : path.resolve(args[0]);

  if (!fs.existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }

  console.log(`Reading ${filePath}...`);

  try {
    const jsonlData = readJsonlFile(filePath);
    console.log(`Parsed ${jsonlData.length} entries`);

    const profile = createFirefoxProfile(jsonlData);
    console.log('Created Firefox profile');

    const { server, serverUrl, shutdownRequested } = await startServer(profile);
    console.log(`Server started at ${serverUrl}`);

    await openProfiler(serverUrl);

    // Wait for the profile to be fetched
    const checkInterval = setInterval(() => {
      if (shutdownRequested()) {
        clearInterval(checkInterval);
        server.close(() => {
          console.log('Profile loaded, server stopped');
          process.exit(0);
        });
      }
    }, 100);

    // Timeout after 60 seconds
    setTimeout(() => {
      clearInterval(checkInterval);
      server.close(() => {
        console.log('Timeout reached, stopping server');
        process.exit(0);
      });
    }, 60000);

  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { readJsonlFile, createFirefoxProfile };

if (require.main === module) {
  main();
}
