import React, { useState, useEffect } from 'react';
import { AlertCircle, CheckCircle, XCircle, Database, TrendingUp } from 'lucide-react';

// ============================================================================
// DATA MODELS & TYPES
// ============================================================================


// ============================================================================
// NORMALIZATION LAYER
// ============================================================================

class EventNormalizer {
  // Field mapping rules - configurable per client
  static fieldMappings = {
    client_id: ['source', 'client', 'client_id', 'clientId'],
    metric: ['metric', 'type', 'event_type', 'metricName'],
    amount: ['amount', 'value', 'total', 'sum'],
    timestamp: ['timestamp', 'ts', 'time', 'date', 'created_at'],
  };

  static normalize(rawEvent) {
    const normalized = {};
    const payload = rawEvent.payload || rawEvent;

    // Extract client_id from root or payload
    normalized.client_id = this.extractField(rawEvent, this.fieldMappings.client_id);
    
    // Extract other fields from payload
    normalized.metric = this.extractField(payload, this.fieldMappings.metric);
    normalized.amount = this.normalizeAmount(
      this.extractField(payload, this.fieldMappings.amount)
    );
    normalized.timestamp = this.normalizeTimestamp(
      this.extractField(payload, this.fieldMappings.timestamp)
    );

    // Generate deterministic hash for deduplication
    normalized.event_hash = this.generateHash(normalized);
    normalized.ingested_at = new Date().toISOString();

    // Validate required fields
    this.validate(normalized);

    return normalized;
  }

  static extractField(obj, possibleKeys) {
    for (const key of possibleKeys) {
      if (obj[key] !== undefined && obj[key] !== null) {
        return obj[key];
      }
    }
    return null;
  }

  static normalizeAmount(value) {
    if (value === null || value === undefined) return 0;
    
    // Handle string numbers
    if (typeof value === 'string') {
      const parsed = parseFloat(value.replace(/,/g, ''));
      return isNaN(parsed) ? 0 : parsed;
    }
    
    return typeof value === 'number' ? value : 0;
  }

  static normalizeTimestamp(value) {
    if (!value) return new Date().toISOString();

    try {
      // Handle various date formats
      let date;
      
      if (typeof value === 'string') {
        // Replace slashes with dashes for ISO format
        const normalized = value.replace(/\//g, '-');
        date = new Date(normalized);
      } else {
        date = new Date(value);
      }

      return isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
    } catch (e) {
      return new Date().toISOString();
    }
  }

  static generateHash(normalized) {
    // Create deterministic hash from semantic content
    // This ensures identical events get same hash regardless of retry
    const hashInput = JSON.stringify({
      client_id: normalized.client_id,
      metric: normalized.metric,
      amount: normalized.amount,
      timestamp: normalized.timestamp?.split('T')[0], // Date only for dedup window
    });
    
    // Simple hash function
    let hash = 0;
    for (let i = 0; i < hashInput.length; i++) {
      const char = hashInput.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(36);
  }

  static validate(normalized) {
    const errors = [];
    
    if (!normalized.client_id) errors.push('Missing client_id');
    if (!normalized.metric) errors.push('Missing metric');
    
    if (errors.length > 0) {
      throw new Error(`Validation failed: ${errors.join(', ')}`);
    }
  }
}

// ============================================================================
// IDEMPOTENT STORAGE LAYER
// ============================================================================

class EventStore {
  constructor() {
    this.events = new Map(); // event_hash -> event
    this.processingLog = new Map(); // event_hash -> status
  }

  async ingest(normalizedEvent, simulateFailure = false) {
    const hash = normalizedEvent.event_hash;

    // STEP 1: Check if already processed (idempotency)
    if (this.events.has(hash)) {
      return {
        success: true,
        duplicate: true,
        event: this.events.get(hash),
      };
    }

    // STEP 2: Mark as processing (prevents double processing on retry)
    if (this.processingLog.get(hash) === 'processing') {
      return {
        success: false,
        error: 'Event already being processed',
        retryable: true,
      };
    }

    this.processingLog.set(hash, 'processing');

    try {
      // STEP 3: Simulate database write
      await this.simulateDbWrite(simulateFailure);

      // STEP 4: Commit event
      this.events.set(hash, normalizedEvent);
      this.processingLog.set(hash, 'completed');

      return {
        success: true,
        duplicate: false,
        event: normalizedEvent,
      };
    } catch (error) {
      // STEP 5: On failure, mark as failed (safe to retry)
      this.processingLog.set(hash, 'failed');
      throw error;
    }
  }

  async simulateDbWrite(shouldFail) {
    await new Promise(resolve => setTimeout(resolve, 100));
    if (shouldFail) {
      throw new Error('Simulated database write failure');
    }
  }

  getAll() {
    return Array.from(this.events.values());
  }

  aggregate(filters = {}) {
    let events = this.getAll();

    // Apply filters
    if (filters.client_id) {
      events = events.filter(e => e.client_id === filters.client_id);
    }
    if (filters.startDate) {
      events = events.filter(e => e.timestamp >= filters.startDate);
    }
    if (filters.endDate) {
      events = events.filter(e => e.timestamp <= filters.endDate);
    }

    // Compute aggregations
    const byClient = {};
    const byMetric = {};
    let totalAmount = 0;
    let totalCount = events.length;

    events.forEach(event => {
      // By client
      if (!byClient[event.client_id]) {
        byClient[event.client_id] = { count: 0, amount: 0 };
      }
      byClient[event.client_id].count++;
      byClient[event.client_id].amount += event.amount;

      // By metric
      if (!byMetric[event.metric]) {
        byMetric[event.metric] = { count: 0, amount: 0 };
      }
      byMetric[event.metric].count++;
      byMetric[event.metric].amount += event.amount;

      totalAmount += event.amount;
    });

    return {
      totalCount,
      totalAmount,
      byClient,
      byMetric,
      events,
    };
  }
}

// ============================================================================
// API LAYER (Ingestion & Query)
// ============================================================================

class DataProcessingAPI {
  constructor() {
    this.store = new EventStore();
    this.failedEvents = [];
  }

  async ingestEvent(rawEvent, simulateFailure = false) {
    try {
      // Normalize
      const normalized = EventNormalizer.normalize(rawEvent);
      
      // Store with idempotency
      const result = await this.store.ingest(normalized, simulateFailure);
      
      return result;
    } catch (error) {
      // Log failed event for visibility
      this.failedEvents.push({
        raw: rawEvent,
        error: error.message,
        timestamp: new Date().toISOString(),
      });
      throw error;
    }
  }

  query(filters) {
    return this.store.aggregate(filters);
  }

  getFailedEvents() {
    return this.failedEvents;
  }
}

// ============================================================================
// REACT UI
// ============================================================================

export default function FaultTolerantSystem() {
  const [api] = useState(() => new DataProcessingAPI());
  const [rawInput, setRawInput] = useState(`{
  "source": "client_A",
  "payload": {
    "metric": "sale",
    "amount": "1200",
    "timestamp": "2024/01/01"
  }
}`);
  const [simulateFailure, setSimulateFailure] = useState(false);
  const [result, setResult] = useState(null);
  const [aggregates, setAggregates] = useState(null);
  const [failedEvents, setFailedEvents] = useState([]);
  const [view, setView] = useState('submit');

  const handleSubmit = async () => {
    try {
      const rawEvent = JSON.parse(rawInput);
      const response = await api.ingestEvent(rawEvent, simulateFailure);
      
      setResult({
        type: response.duplicate ? 'duplicate' : 'success',
        message: response.duplicate 
          ? 'Event already processed (duplicate detected)'
          : 'Event processed successfully',
        event: response.event,
      });
      
      refreshAggregates();
    } catch (error) {
      setResult({
        type: 'error',
        message: error.message,
      });
      setFailedEvents(api.getFailedEvents());
    }
  };

  const refreshAggregates = useCallback(() => {
  setAggregates(api.query({}));
  setFailedEvents(api.getFailedEvents());
}, [api]);

useEffect(() => {
  refreshAggregates();
}, [refreshAggregates]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white p-8">
      <div className="max-w-7xl mx-auto">
        <header className="mb-8">
          <h1 className="text-4xl font-bold mb-2 bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">
            Fault-Tolerant Data Processing System
          </h1>
          <p className="text-slate-400">Handles unreliable data with idempotency and graceful failure handling</p>
        </header>

        {/* Navigation */}
        <div className="flex gap-2 mb-6">
          {['submit', 'processed', 'failed', 'aggregates'].map(tab => (
            <button
              key={tab}
              onClick={() => setView(tab)}
              className={`px-4 py-2 rounded-lg font-medium transition-all ${
                view === tab
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
              }`}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        {/* Submit Event View */}
        {view === 'submit' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-slate-800 rounded-xl p-6 border border-slate-700">
              <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
                <Database className="w-5 h-5 text-blue-400" />
                Submit Event
              </h2>
              
              <textarea
                value={rawInput}
                onChange={(e) => setRawInput(e.target.value)}
                className="w-full h-64 bg-slate-900 border border-slate-600 rounded-lg p-4 font-mono text-sm text-slate-200 mb-4"
                placeholder="Enter raw event JSON..."
              />

              <div className="flex items-center gap-3 mb-4">
                <input
                  type="checkbox"
                  id="simulate"
                  checked={simulateFailure}
                  onChange={(e) => setSimulateFailure(e.target.checked)}
                  className="w-4 h-4"
                />
                <label htmlFor="simulate" className="text-slate-300">
                  Simulate database failure
                </label>
              </div>

              <button
                onClick={handleSubmit}
                className="w-full bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white font-semibold py-3 rounded-lg transition-all"
              >
                Submit Event
              </button>
            </div>

            <div className="bg-slate-800 rounded-xl p-6 border border-slate-700">
              <h2 className="text-xl font-semibold mb-4">Result</h2>
              
              {result ? (
                <div className={`p-4 rounded-lg border ${
                  result.type === 'success' ? 'bg-green-900/20 border-green-700' :
                  result.type === 'duplicate' ? 'bg-yellow-900/20 border-yellow-700' :
                  'bg-red-900/20 border-red-700'
                }`}>
                  <div className="flex items-start gap-3 mb-3">
                    {result.type === 'error' ? (
                      <XCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                    ) : result.type === 'duplicate' ? (
                      <AlertCircle className="w-5 h-5 text-yellow-400 flex-shrink-0 mt-0.5" />
                    ) : (
                      <CheckCircle className="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" />
                    )}
                    <div>
                      <p className="font-semibold">{result.message}</p>
                    </div>
                  </div>
                  
                  {result.event && (
                    <pre className="bg-slate-900 p-3 rounded text-xs overflow-auto">
                      {JSON.stringify(result.event, null, 2)}
                    </pre>
                  )}
                </div>
              ) : (
                <p className="text-slate-400 text-center py-8">Submit an event to see results</p>
              )}

              <div className="mt-6 p-4 bg-slate-900 rounded-lg text-sm">
                <h3 className="font-semibold mb-2 text-blue-400">Quick Test Cases:</h3>
                <ul className="space-y-1 text-slate-300 text-xs">
                  <li>• Submit same event twice → duplicate detection</li>
                  <li>• Enable failure → safe retry handling</li>
                  <li>• Missing fields → graceful defaults</li>
                  <li>• Different formats → normalization</li>
                </ul>
              </div>
            </div>
          </div>
        )}

        {/* Processed Events View */}
        {view === 'processed' && aggregates && (
          <div className="bg-slate-800 rounded-xl p-6 border border-slate-700">
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
              <CheckCircle className="w-5 h-5 text-green-400" />
              Successfully Processed Events ({aggregates.totalCount})
            </h2>
            
            {aggregates.events.length > 0 ? (
              <div className="space-y-3">
                {aggregates.events.map((event, idx) => (
                  <div key={idx} className="bg-slate-900 p-4 rounded-lg border border-slate-700">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                      <div>
                        <span className="text-slate-400">Client:</span>
                        <p className="font-semibold text-blue-400">{event.client_id}</p>
                      </div>
                      <div>
                        <span className="text-slate-400">Metric:</span>
                        <p className="font-semibold">{event.metric}</p>
                      </div>
                      <div>
                        <span className="text-slate-400">Amount:</span>
                        <p className="font-semibold text-green-400">${event.amount.toLocaleString()}</p>
                      </div>
                      <div>
                        <span className="text-slate-400">Timestamp:</span>
                        <p className="font-semibold text-xs">{new Date(event.timestamp).toLocaleString()}</p>
                      </div>
                    </div>
                    <div className="mt-2 text-xs text-slate-500">
                      Hash: {event.event_hash}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-slate-400 text-center py-8">No events processed yet</p>
            )}
          </div>
        )}

        {/* Failed Events View */}
        {view === 'failed' && (
          <div className="bg-slate-800 rounded-xl p-6 border border-slate-700">
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
              <XCircle className="w-5 h-5 text-red-400" />
              Failed Events ({failedEvents.length})
            </h2>
            
            {failedEvents.length > 0 ? (
              <div className="space-y-3">
                {failedEvents.map((failure, idx) => (
                  <div key={idx} className="bg-red-900/10 p-4 rounded-lg border border-red-700">
                    <p className="text-red-400 font-semibold mb-2">{failure.error}</p>
                    <pre className="bg-slate-900 p-3 rounded text-xs overflow-auto text-slate-300">
                      {JSON.stringify(failure.raw, null, 2)}
                    </pre>
                    <p className="text-xs text-slate-500 mt-2">{new Date(failure.timestamp).toLocaleString()}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-slate-400 text-center py-8">No failed events</p>
            )}
          </div>
        )}

        {/* Aggregates View */}
        {view === 'aggregates' && aggregates && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="bg-gradient-to-br from-blue-900/40 to-blue-800/40 rounded-xl p-6 border border-blue-700">
                <h3 className="text-lg font-semibold mb-2 flex items-center gap-2">
                  <TrendingUp className="w-5 h-5" />
                  Total Events
                </h3>
                <p className="text-4xl font-bold">{aggregates.totalCount}</p>
              </div>
              
              <div className="bg-gradient-to-br from-green-900/40 to-green-800/40 rounded-xl p-6 border border-green-700">
                <h3 className="text-lg font-semibold mb-2 flex items-center gap-2">
                  <TrendingUp className="w-5 h-5" />
                  Total Amount
                </h3>
                <p className="text-4xl font-bold">${aggregates.totalAmount.toLocaleString()}</p>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="bg-slate-800 rounded-xl p-6 border border-slate-700">
                <h3 className="text-lg font-semibold mb-4">By Client</h3>
                <div className="space-y-3">
                  {Object.entries(aggregates.byClient).map(([client, data]) => (
                    <div key={client} className="bg-slate-900 p-4 rounded-lg">
                      <div className="flex justify-between items-center mb-2">
                        <span className="font-semibold text-blue-400">{client}</span>
                        <span className="text-sm text-slate-400">{data.count} events</span>
                      </div>
                      <div className="text-2xl font-bold text-green-400">
                        ${data.amount.toLocaleString()}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-slate-800 rounded-xl p-6 border border-slate-700">
                <h3 className="text-lg font-semibold mb-4">By Metric</h3>
                <div className="space-y-3">
                  {Object.entries(aggregates.byMetric).map(([metric, data]) => (
                    <div key={metric} className="bg-slate-900 p-4 rounded-lg">
                      <div className="flex justify-between items-center mb-2">
                        <span className="font-semibold text-purple-400">{metric}</span>
                        <span className="text-sm text-slate-400">{data.count} events</span>
                      </div>
                      <div className="text-2xl font-bold text-green-400">
                        ${data.amount.toLocaleString()}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
