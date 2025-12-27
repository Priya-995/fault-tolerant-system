# Fault-Tolerant Data Processing System

A robust data ingestion and processing system that handles unreliable data from multiple clients with built-in fault tolerance, deduplication, and graceful failure handling.

## 🎯 Project Overview

This system receives events from multiple external clients that:
- Do not follow a strict schema
- Change formats without notice
- May resend events
- May fail mid-request

The system ensures:
- ✅ Normalized data processing
- ✅ Duplicate event prevention
- ✅ Safe partial failure handling
- ✅ Consistent aggregated outputs

---

## 🚀 Quick Start

### Prerequisites
- Node.js (v14 or higher)
- npm (v6 or higher)

### Installation

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/fault-tolerant-system.git
cd fault-tolerant-system

# Install dependencies
npm install

# Start development server
npm start
```

The application will open at `http://localhost:3000`

---

## 📁 Project Structure

```
fault-tolerant-system/
├── src/
│   ├── App.js              # Main application component
│   ├── index.js            # Entry point
│   └── index.css           # Global styles
├── public/
│   └── index.html
├── package.json
└── README.md
```

### Architecture Components

**EventNormalizer**
- Flexible field mapping for inconsistent schemas
- Type coercion (strings → numbers, various date formats)
- Graceful handling of missing fields
- Deterministic hash generation for deduplication

**EventStore**
- Idempotent storage with deduplication
- Processing log to prevent race conditions
- Safe retry handling
- Atomic state transitions

**DataProcessingAPI**
- Event ingestion orchestration
- Query and aggregation layer
- Failed event tracking

**React UI**
- Manual event submission
- Failure simulation toggle
- Multi-view dashboard (Submit, Processed, Failed, Aggregates)

---

## 🎨 Features

### 1. Event Ingestion
- Accepts events in flexible JSON format
- Handles multiple field name variations
- Processes events with missing or extra fields

### 2. Normalization Layer
Converts raw events to canonical format:

**Input Example:**
```json
{
  "source": "client_A",
  "payload": {
    "metric": "sale",
    "amount": "1200",
    "timestamp": "2024/01/01"
  }
}
```

**Output (Canonical):**
```json
{
  "client_id": "client_A",
  "metric": "sale",
  "amount": 1200,
  "timestamp": "2024-01-01T00:00:00Z",
  "event_hash": "abc123",
  "ingested_at": "2024-01-15T10:30:00Z"
}
```

### 3. Idempotency & Deduplication
- Content-based hash generation
- Prevents double counting on retries
- Safe concurrent request handling

### 4. Partial Failure Handling
- Events marked as "processing" during ingestion
- Failed writes leave system in consistent state
- Safe retry mechanism without data loss

### 5. Query & Aggregation API
- Real-time aggregations by client and metric
- Total counts and amounts
- Extensible filtering system

### 6. Interactive UI
- **Submit View**: Manual event submission with JSON editor
- **Processed View**: Successfully ingested events
- **Failed View**: Events that failed validation or ingestion
- **Aggregates View**: Real-time analytics and totals

---

## 🧪 Testing the System

### Test Case 1: Normal Event Processing
1. Navigate to "Submit" tab
2. Use the default JSON event
3. Click "Submit Event"
4. Verify event appears in "Processed" tab
5. Check "Aggregates" tab for updated totals

### Test Case 2: Duplicate Detection
1. Submit the same event twice
2. Second submission should show: "Event already processed (duplicate detected)"
3. Verify only ONE event in "Processed" tab
4. Aggregates should not double-count

### Test Case 3: Database Failure Simulation
1. Check "Simulate database failure" checkbox
2. Click "Submit Event"
3. Event should appear in "Failed" tab
4. Uncheck the failure option
5. Submit same event again
6. Event should now succeed and appear in "Processed" tab

### Test Case 4: Schema Flexibility

Try these different formats:

```json
{
  "client": "client_B",
  "payload": {
    "type": "purchase",
    "value": 5000,
    "time": "2024-12-01"
  }
}
```

```json
{
  "source": "client_C",
  "payload": {
    "metricName": "refund",
    "sum": "250.50",
    "created_at": "2024/12/15"
  }
}
```

All should normalize correctly!

---

## 💡 Design Decisions

### What assumptions did you make?

1. **Events are semantically unique** based on client_id, metric, amount, and timestamp (date only)
2. **Duplicates are unintentional** - caused by retries, not legitimate repeated events
3. **Missing fields can have defaults** - amount defaults to 0, timestamp to current time
4. **Single-server deployment** - no distributed systems complexity needed for prototype
5. **In-memory storage is acceptable** - would use PostgreSQL/Redis in production

### How does your system prevent double counting?

**Three-Layer Deduplication Strategy:**

1. **Content-Based Hash Generation**
   - Hash generated from semantic content (client_id, metric, amount, date)
   - Same event produces identical hash regardless of retry timing
   - Deterministic and reliable

2. **Idempotent Storage Check**
   ```javascript
   if (this.events.has(hash)) {
     return { success: true, duplicate: true };
   }
   if (this.processingLog.get(hash) === 'processing') {
     return { success: false, retryable: true };
   }
   ```

3. **Processing Log**
   - Tracks event state: `not_seen` → `processing` → `completed`/`failed`
   - Prevents concurrent processing during retry storms
   - Acts as distributed lock in single-server context

### What happens if the database fails mid-request?

**Failure Flow:**
1. Event normalized ✓
2. Deduplication check ✓
3. Processing log updated: `hash → "processing"` ✓
4. Database write FAILS ✗
5. Exception caught
6. Processing log updated: `hash → "failed"`
7. Error returned to client
8. Client retries
9. System allows retry (failed status)
10. Retry succeeds, event committed

**Guarantees:**
- ✅ No data loss (client retries)
- ✅ No double processing (hash prevents duplicates)
- ✅ Consistent state (processing log tracks status)

### What would break first at scale?

**Priority Order:**

1. **In-Memory Storage** (Breaks at: ~1M-10M events)
   - Fix: Use PostgreSQL with unique constraints on event_hash
   - Add Redis for processing log (distributed lock)

2. **Synchronous Processing** (Breaks at: ~100-1000 req/sec)
   - Fix: Add message queue (RabbitMQ/Kafka)
   - Multiple workers process events async
   - API returns 202 Accepted immediately

3. **Content-Based Hashing** (Breaks at: High-frequency identical events)
   - Fix: Include hour/minute in hash for finer granularity
   - Add TTL to deduplication cache (24 hours)
   - Allow client-provided idempotency keys

4. **Aggregation Queries** (Breaks at: ~100K+ events)
   - Fix: Add database indexes on filterable fields
   - Pre-compute aggregates in background jobs
   - Use time-series database (ClickHouse, TimescaleDB)

5. **Single Point of Failure** (Breaks at: Server goes down)
   - Fix: Deploy multiple app servers behind load balancer
   - Use distributed lock (Redis Redlock)
   - Database replication and failover

---

## 🏗️ Architecture

```
┌─────────────┐
│   Client    │
└──────┬──────┘
       │ Raw Event (unreliable)
       ▼
┌─────────────────────┐
│  API Layer          │
│  (ingestEvent)      │
└──────┬──────────────┘
       │
       ▼
┌─────────────────────┐
│ Normalization Layer │
│ - Field mapping     │
│ - Type conversion   │
│ - Hash generation   │
└──────┬──────────────┘
       │ Canonical Event
       ▼
┌─────────────────────┐
│ Storage Layer       │
│ - Deduplication     │
│ - Processing log    │
│ - ACID guarantees   │
└──────┬──────────────┘
       │
       ▼
┌─────────────────────┐
│ Query/Aggregation   │
│ - Filter events     │
│ - Compute totals    │
└─────────────────────┘
```

---

## 🛠️ Technologies Used

- **React 18** - UI framework
- **Lucide React** - Icon library
- **Tailwind CSS** - Utility-first styling
- **JavaScript ES6+** - Modern language features

---

## 📦 Dependencies

```json
{
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "lucide-react": "^0.263.1"
  }
}
```

---

## 🔧 Available Scripts

```bash
# Start development server
npm start

# Build for production
npm run build

# Run tests
npm test

# Eject from Create React App (irreversible)
npm run eject
```

---

## 🚀 Production Deployment

### Build

```bash
npm run build
```

Creates optimized production build in `build/` folder.

### Serve Static Build

```bash
npx serve -s build
```

### Deploy to Services

- **Vercel**: `vercel --prod`
- **Netlify**: Drag & drop `build/` folder
- **GitHub Pages**: Use `gh-pages` package
- **AWS S3**: Upload `build/` to S3 bucket with static hosting

---

## 🎯 Key Design Strengths

✅ **Clean separation of concerns** - Normalization, storage, API clearly separated  
✅ **Idempotent by design** - Same request N times = same result  
✅ **Graceful degradation** - Handles missing fields without crashing  
✅ **Observable** - Failed events logged separately for debugging  
✅ **Extensible** - Easy to add new field mappings or clients  
✅ **Testable** - Pure functions for hash generation and normalization  

---

## 📝 Future Enhancements

- [ ] Persistent storage with PostgreSQL
- [ ] Async processing with message queues
- [ ] Client-specific schema configuration UI
- [ ] Advanced filtering and search
- [ ] Export aggregations to CSV/JSON
- [ ] Real-time updates with WebSockets
- [ ] Authentication and authorization
- [ ] Rate limiting per client
- [ ] Monitoring and alerting dashboard
- [ ] API documentation with Swagger

---

**⭐ If you found this project helpful, please give it a star!**
