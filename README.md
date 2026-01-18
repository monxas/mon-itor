# mon-itor

A powerful web monitoring tool using Playwright. Handles dynamic pages, cookie popups, forms, complex interactions, JSON APIs, and more.

## Features

- **Retry with exponential backoff** - Automatic retries on failures
- **Per-watch intervals + cron schedules** - Flexible scheduling options
- **Proxy support** - Global or per-watch proxy configuration
- **Custom headers/cookies** - Full control over request context
- **Conditional actions** - Execute actions based on conditions
- **Screenshot on error** - Automatic debugging screenshots
- **Isolated browser contexts** - Each watch runs in isolation
- **Rate limiting** - Staggered checks to avoid overwhelming targets
- **Web UI dashboard** - Visual status at `/`
- **Health endpoint** - JSON API at `/health`
- **Prometheus metrics** - Metrics at `/metrics`
- **Transform chaining** - Apply multiple transforms in sequence
- **Notification throttling** - Prevent spam from flapping sites
- **JSON extractor with JSONPath** - Extract data from JSON APIs
- **Per-extractor comparators** - Different comparison methods per field
- **Error notifications** - Alert after N consecutive failures
- **Diff in notifications** - Show changes with `{{diff.field}}`
- **Config validation** - Validates config on load
- **Hot reload** - Detects config changes every 30 seconds
- **Multiple notification channels** - Per-watch notification config
- **Authentication/login flows** - Built-in login action
- **Persistent browser sessions** - Save cookies/localStorage between runs
- **XPath selector support** - Use XPath alongside CSS selectors

## Quick Start

```bash
# Build
docker build -t web-monitor .

# Run
docker run -d \
  -v /path/to/configs:/config \
  -v /path/to/state:/state \
  -e TELEGRAM_BOT_TOKEN=your_token \
  -e TELEGRAM_CHAT_ID=your_chat_id \
  web-monitor
```

## Web Dashboard

Access the dashboard at `http://localhost:8080/` to see:
- Status of all watches
- Last check time
- Error counts
- Real-time health status

## Configuration

Create JSON files in the `/config` directory. Each file defines a watch. Changes are detected automatically (hot reload).

### Basic Structure

```json
{
  "id": "unique-id",
  "name": "Human readable name",
  "url": "https://example.com",
  "enabled": true,
  "interval": 300000,
  "actions": [...],
  "extractors": [...],
  "comparator": "hash"
}
```

### Watch Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `id` | string | md5(url) | Unique identifier |
| `name` | string | - | Human-readable name |
| `url` | string | **required** | URL to monitor |
| `enabled` | boolean | true | Enable/disable watch |
| `interval` | number | env default | Check interval in ms |
| `schedule` | string | - | Cron expression (instead of interval) |
| `timeout` | number | 60000 | Page load timeout |
| `retries` | number | 3 | Max retry attempts |
| `waitUntil` | string | "networkidle" | Page load strategy |
| `waitForSelector` | string | - | Wait for element before extraction |
| `waitMs` | number | - | Additional wait time |
| `userAgent` | string | Chrome UA | Custom user agent |
| `viewport` | object | 1280x720 | Browser viewport size |
| `locale` | string | "en-US" | Browser locale |
| `timezone` | string | "America/New_York" | Browser timezone |
| `headers` | object | - | Custom HTTP headers |
| `cookies` | array | - | Cookies to set |
| `proxy` | string/object | - | Proxy server |
| `blockResources` | array | - | Resource types to block |
| `screenshotOnError` | boolean | true | Save screenshot on error |
| `persistSession` | boolean | false | Save session between runs |
| `notifications` | array | - | Per-watch notification channels |
| `notifyOnError` | boolean | true | Send error notifications |
| `errorThreshold` | number | 3 | Consecutive failures before notification |

### Cron Schedules

Use cron expressions instead of intervals:

```json
{
  "id": "daily-check",
  "name": "Daily 9AM Check",
  "url": "https://example.com",
  "schedule": "0 9 * * *",
  "extractors": [...]
}
```

Cron format: `minute hour dayOfMonth month dayOfWeek`

Supports:
- Numbers: `30 9 * * *` (9:30 AM daily)
- Wildcards: `*/5 * * * *` (every 5 minutes)
- Ranges: `0 9-17 * * *` (every hour 9AM-5PM)
- Lists: `0 9,12,18 * * *` (at 9AM, 12PM, 6PM)

### Actions

Actions run before extraction. Use them to dismiss popups, fill forms, navigate, etc.

| Type | Description | Properties |
|------|-------------|------------|
| `wait` | Wait fixed time | `ms` |
| `waitForSelector` | Wait for CSS element | `selector`, `timeout`, `state` |
| `waitForXPath` | Wait for XPath element | `selector`, `timeout`, `state` |
| `waitForNavigation` | Wait for navigation | `timeout`, `waitUntil` |
| `click` | Click element | `selector`, `checkFrames`, `optional`, `xpath` |
| `type` | Type into input (instant) | `selector`, `value` |
| `typeSlowly` | Type with delay between keys | `selector`, `value`, `delay` |
| `pressKey` | Press keyboard key | `key` |
| `select` | Select dropdown option | `selector`, `value` |
| `hover` | Hover over element | `selector` |
| `scroll` | Scroll page/element | `selector`, `x`, `y` |
| `evaluate` | Run JavaScript | `script` |
| `screenshot` | Save screenshot | `path`, `fullPage` |
| `setVariable` | Set context variable | `name`, `value` |
| `login` | Login flow shorthand | See below |

#### Login Action

Shorthand for common login patterns:

```json
{
  "type": "login",
  "usernameSelector": "#email",
  "username": "user@example.com",
  "passwordSelector": "#password",
  "password": "secret",
  "submitSelector": "#login-btn"
}
```

#### Conditional Actions

Actions can be conditional using the `if` property:

```json
{
  "type": "click",
  "selector": ".cookie-accept",
  "if": {
    "type": "exists",
    "selector": ".cookie-popup"
  }
}
```

Condition types:
- `exists` - Element exists
- `notExists` - Element doesn't exist
- `textContains` - Element text contains value
- `variable` - Context variable is truthy
- `evaluate` - Custom JS returns true

### Extractors

Define what data to extract from the page.

| Type | Description | Returns |
|------|-------------|---------|
| `text` | Element textContent | Array of strings |
| `innerText` | Element innerText | Array of strings |
| `attribute` | Element attribute | Array of values |
| `value` | Input/select value | Array of values |
| `options` | All select options | Array of {value, text} |
| `html` | Element innerHTML | Array of strings |
| `outerHtml` | Element outerHTML | Array of strings |
| `count` | Number of matches | Number |
| `exists` | Element exists? | Boolean |
| `url` | Current page URL | String |
| `title` | Page title | String |
| `xpath` | XPath text extraction | Array of strings |
| `evaluate` | Custom JS | Any |
| `json` | Parse body as JSON | Object/Array |
| `jsonFromScript` | JSON from script tag | Object/Array |
| `screenshot` | Element/page screenshot | File path |

#### JSON Extractor

For API monitoring or pages that return JSON:

```json
{
  "name": "score",
  "type": "json",
  "path": "$.data.event.score.homeTeam.totalScore"
}
```

Supports JSONPath expressions:
- `$.field` - Root field
- `$.nested.field` - Nested field
- `$.array[0]` - Array index
- `$.array[0].field` - Field from array element

#### JSON from Script Tag

Extract JSON from embedded `<script>` tags:

```json
{
  "name": "data",
  "type": "jsonFromScript",
  "selector": "script#__NEXT_DATA__",
  "path": "$.props.pageProps.data"
}
```

#### XPath Extractor

Use XPath selectors:

```json
{
  "name": "title",
  "type": "xpath",
  "selector": "//h1[@class='title']"
}
```

#### Per-Extractor Comparators

Each extractor can have its own comparator:

```json
{
  "extractors": [
    {
      "name": "count",
      "type": "count",
      "selector": ".items",
      "comparator": "numeric",
      "threshold": 5
    },
    {
      "name": "items",
      "type": "text",
      "selector": ".item",
      "comparator": "added"
    },
    {
      "name": "metadata",
      "type": "text",
      "selector": ".meta",
      "comparator": "none"
    }
  ]
}
```

Extractor options:
- `name` - Result field name
- `selector` - CSS selector (or XPath for xpath type)
- `xpath` - Set true to use XPath for CSS selector types
- `attribute` - For attribute type
- `path` - JSONPath for json/jsonFromScript types
- `checkFrames` - Also search in iframes
- `default` - Default value on error
- `transform` / `transforms` - Data transforms
- `comparator` - Per-extractor comparator
- `threshold` - For numeric comparators

### Transforms

Apply to extracted data. Can be a single transform or chained array.

**Single transform:**
```json
{
  "name": "times",
  "type": "options",
  "selector": "select",
  "transform": "filter",
  "filter": { "exclude": ["14:00"] }
}
```

**Chained transforms:**
```json
{
  "name": "prices",
  "type": "text",
  "selector": ".price",
  "transforms": [
    "trim",
    { "type": "regex", "pattern": "\\d+\\.\\d+" },
    "parseNumber",
    { "type": "sort", "desc": true },
    "first"
  ]
}
```

Available transforms:

| Transform | Description | Options |
|-----------|-------------|---------|
| `flatten` | Flatten nested arrays | `depth` |
| `unique` | Remove duplicates | - |
| `sort` | Sort array | `key`, `desc` |
| `reverse` | Reverse array | - |
| `join` | Join to string | `separator` |
| `split` | Split string | `separator` |
| `first` | Get first item | - |
| `last` | Get last item | - |
| `slice` | Slice array | `start`, `end` |
| `filter` | Filter items | `include`, `exclude` |
| `map` / `pluck` | Extract property | `key` |
| `trim` | Trim whitespace | - |
| `lowercase` | Convert to lowercase | - |
| `uppercase` | Convert to uppercase | - |
| `regex` | Extract with regex | `pattern`, `flags` |
| `replace` | Replace pattern | `pattern`, `replacement`, `flags` |
| `parseNumber` | Parse numbers | - |
| `parseJson` | Parse JSON string | - |
| `jsonPath` | Apply JSONPath | `path` |
| `compact` | Remove null/empty values | - |

### Comparators

How to detect changes:

| Comparator | Description | Options |
|------------|-------------|---------|
| `hash` | MD5 hash of data (any change) | - |
| `exact` | JSON equality | - |
| `length` | Array/string length changed | - |
| `added` | New items in array | - |
| `removed` | Items removed from array | - |
| `addedOrRemoved` | Items added or removed | - |
| `numeric` | Numeric value changed | `threshold` |
| `increased` | Value increased | `threshold` |
| `decreased` | Value decreased | `threshold` |
| `none` | Never triggers (for template-only fields) | - |
| `custom` | Custom JS function | `customComparator` |

### Notifications

#### Global Notifications

Set via environment variables (Telegram, ntfy, webhook).

#### Per-Watch Notifications

Configure multiple channels per watch:

```json
{
  "id": "my-watch",
  "notifications": [
    {
      "type": "telegram",
      "token": "bot_token",
      "chatId": "chat_id"
    },
    {
      "type": "ntfy",
      "url": "https://ntfy.sh/mytopic",
      "priority": "high",
      "tags": "warning"
    },
    {
      "type": "webhook",
      "url": "https://example.com/webhook",
      "headers": { "Authorization": "Bearer xxx" }
    }
  ]
}
```

#### Error Notifications

Notify after consecutive failures:

```json
{
  "notifyOnError": true,
  "errorThreshold": 3
}
```

### Message Templates

Customize notifications with `messageTemplate`:

```json
{
  "messageTemplate": "🔔 <b>{{name}}</b>\n\nNew items: {{addedList}}\n\n<a href=\"{{url}}\">View</a>"
}
```

Available placeholders:

| Placeholder | Description |
|-------------|-------------|
| `{{name}}` | Watch name |
| `{{url}}` | Watch URL |
| `{{timestamp}}` | Current timestamp |
| `{{changes}}` | Full changes JSON |
| `{{data}}` | Full extracted data JSON |
| `{{added}}` | Comma-separated added items |
| `{{removed}}` | Comma-separated removed items |
| `{{addedList}}` | Bullet list of added items |
| `{{removedList}}` | Bullet list of removed items |
| `{{addedCount}}` | Count of added items |
| `{{removedCount}}` | Count of removed items |
| `{{current.fieldname}}` | Current value of field |
| `{{previous.fieldname}}` | Previous value of field |
| `{{diff.fieldname}}` | Show change with diff (e.g., "5 → 10 (+5)") |

## Environment Variables

### Core Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `CONFIG_DIR` | /config | Config files directory |
| `STATE_DIR` | /state | State files directory |
| `SCREENSHOT_DIR` | /state/screenshots | Error screenshots |
| `SESSION_DIR` | /state/sessions | Persistent session storage |
| `CHECK_INTERVAL_MS` | 300000 | Default check interval (5 min) |
| `HEALTH_PORT` | 8080 | Health endpoint port |

### Retry/Rate Limiting

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_RETRIES` | 3 | Max retry attempts |
| `RETRY_BASE_DELAY_MS` | 5000 | Initial retry delay |
| `STAGGER_DELAY_MS` | 2000 | Delay between watch starts |
| `NOTIFICATION_THROTTLE_MS` | 60000 | Min time between notifications |
| `ERROR_NOTIFY_THRESHOLD` | 3 | Consecutive failures before error notification |

### Proxy

| Variable | Description |
|----------|-------------|
| `PROXY_SERVER` | Global proxy server URL |
| `PROXY_USERNAME` | Proxy username |
| `PROXY_PASSWORD` | Proxy password |

### Notifications

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `TELEGRAM_CHAT_ID` | Telegram chat ID |
| `NTFY_URL` | ntfy.sh topic URL |
| `WEBHOOK_URL` | Webhook URL for JSON POST |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Web dashboard |
| `/health` | GET | JSON health status |
| `/metrics` | GET | Prometheus metrics |
| `/api/trigger?id=xxx` | POST | Manually trigger a watch |

### Health Response

```json
{
  "status": "healthy",
  "uptime": 3600,
  "watches": [
    {
      "id": "my-watch",
      "name": "My Watch",
      "success": true,
      "lastCheck": "2024-01-01T00:00:00.000Z",
      "errorCount": 0
    }
  ],
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### Manual Trigger

```bash
curl -X POST "http://localhost:8080/api/trigger?id=my-watch"
```

## Examples

### Monitor Select Options with Filter

```json
{
  "id": "ski-classes",
  "name": "Ski Class Times",
  "url": "https://example.com/booking",
  "interval": 300000,
  "actions": [
    {
      "type": "click",
      "selector": ".cookie-accept",
      "checkFrames": true,
      "optional": true
    },
    {
      "type": "waitForSelector",
      "selector": "select.times"
    }
  ],
  "extractors": [
    {
      "name": "times",
      "type": "evaluate",
      "script": "Array.from(document.querySelectorAll('select.times option')).filter(o => o.value).map(o => o.value)"
    }
  ],
  "comparator": "added",
  "messageTemplate": "🎿 New times: {{addedList}}"
}
```

### JSON API Monitoring

```json
{
  "id": "api-monitor",
  "name": "API Data",
  "url": "https://api.example.com/data",
  "extractors": [
    {
      "name": "count",
      "type": "json",
      "path": "$.data.items.length",
      "comparator": "increased"
    },
    {
      "name": "status",
      "type": "json",
      "path": "$.data.status",
      "comparator": "exact"
    }
  ],
  "messageTemplate": "📊 API Update!\n\nCount: {{diff.count}}\nStatus: {{current.status}}"
}
```

### Login-Protected Page

```json
{
  "id": "dashboard",
  "name": "Protected Dashboard",
  "url": "https://example.com/login",
  "persistSession": true,
  "actions": [
    {
      "type": "login",
      "usernameSelector": "#email",
      "username": "user@example.com",
      "passwordSelector": "#password",
      "password": "${PASSWORD}",
      "submitSelector": "#login",
      "if": { "type": "exists", "selector": "#email" }
    },
    {
      "type": "waitForSelector",
      "selector": ".dashboard"
    }
  ],
  "extractors": [
    { "name": "stats", "type": "text", "selector": ".stats" }
  ]
}
```

### Cron-Scheduled Check

```json
{
  "id": "morning-check",
  "name": "Morning Availability",
  "url": "https://example.com/availability",
  "schedule": "0 9 * * 1-5",
  "extractors": [
    { "name": "slots", "type": "count", "selector": ".available-slot" }
  ],
  "comparator": "increased",
  "messageTemplate": "✅ {{current.slots}} slots available!"
}
```

### Price Monitoring with Threshold

```json
{
  "id": "price-tracker",
  "name": "Product Price",
  "url": "https://example.com/product",
  "interval": 3600000,
  "extractors": [
    {
      "name": "price",
      "type": "text",
      "selector": ".price",
      "transforms": ["trim", "parseNumber"],
      "comparator": "decreased",
      "threshold": 10
    }
  ],
  "messageTemplate": "💰 Price dropped!\n\n{{diff.price}}"
}
```

### XPath Extraction

```json
{
  "id": "xpath-example",
  "name": "XPath Test",
  "url": "https://example.com",
  "extractors": [
    {
      "name": "title",
      "type": "xpath",
      "selector": "//h1[contains(@class, 'title')]"
    },
    {
      "name": "links",
      "type": "attribute",
      "selector": "//a[@class='nav-link']",
      "xpath": true,
      "attribute": "href"
    }
  ]
}
```

### Multiple Notification Channels

```json
{
  "id": "important-watch",
  "name": "Critical Monitor",
  "url": "https://example.com",
  "extractors": [
    { "name": "status", "type": "text", "selector": ".status" }
  ],
  "notifications": [
    {
      "type": "telegram",
      "chatId": "-100123456789"
    },
    {
      "type": "ntfy",
      "url": "https://ntfy.sh/alerts",
      "priority": "urgent"
    }
  ]
}
```

## Docker Compose

```yaml
services:
  web-monitor:
    build: /home/monxas/scripts/web-monitor
    container_name: web-monitor
    restart: unless-stopped
    ports:
      - "8089:8080"  # Dashboard + health
    environment:
      - TZ=Europe/Madrid
      - TELEGRAM_BOT_TOKEN=xxx
      - TELEGRAM_CHAT_ID=xxx
      - CHECK_INTERVAL_MS=300000
      - MAX_RETRIES=3
      - NOTIFICATION_THROTTLE_MS=60000
      - ERROR_NOTIFY_THRESHOLD=3
    volumes:
      - /home/monxas/appdata/web-monitor/config:/config
      - /home/monxas/appdata/web-monitor/state:/state
```

## Prometheus Integration

Add to your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: 'web-monitor'
    static_configs:
      - targets: ['web-monitor:8080']
```

Metrics exposed:
- `web_monitor_up` - Whether the monitor is running (1/0)
- `web_monitor_uptime_seconds` - Uptime in seconds
- `web_monitor_watch_success{watch="id",name="name"}` - Last check success (1/0)
- `web_monitor_watch_errors_total{watch="id",name="name"}` - Total error count
