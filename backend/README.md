# Monochrome Backend

Backend service for server-side track downloading in Monochrome.

## Features

- Automatic track downloading to server when users play tracks
- Cache management to avoid duplicate downloads
- Multiple API instance support with failover
- Graceful degradation when backend is unavailable

## Setup

### Installation

```bash
cd backend
npm install
```

### Configuration

Copy `.env.example` to `.env` and configure:

```env
PORT=3001
STORAGE_PATH=./storage/tracks
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3000
LOG_LEVEL=info
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change-me
```

**Note:** API instances and quality settings are sent from the frontend (user settings), not configured on the backend. This allows each user to use their own preferred API instances and quality settings.

### Admin UI

The backend ships with a lightweight admin UI for server preferences:

- URL: `http://localhost:3001/admin`
- Protected with HTTP Basic Auth using `ADMIN_USERNAME` and `ADMIN_PASSWORD`
- Preferences are stored in a local JSON file alongside storage (not in `.env`)

Currently supported preferences:

- Filename template (same tokens as the main frontend: `{trackNumber}`, `{artist}`, `{title}`, `{album}`, `{albumArtist}`, `{albumTitle}`, `{year}`)
- Download quality (use playback quality or force `HI_RES_LOSSLESS`, `LOSSLESS`, `HIGH`, `LOW`)

### Running

Development mode (with auto-reload):

```bash
npm run dev
```

Production mode:

```bash
npm start
```

## API Endpoints

### POST /api/download/trigger

Triggers a track download.

**Request Body:**

```json
{
    "trackId": "123456",
    "quality": "HI_RES_LOSSLESS",
    "apiInstances": ["https://triton.squid.wtf", "https://wolf.qqdl.site", "https://monochrome-api.samidy.com"]
}
```

- `trackId` (required): The track ID to download
- `quality` (optional, default: HI_RES_LOSSLESS): Audio quality
- `apiInstances` (required): Array of API instance URLs to use

**Response:**

```json
{
    "success": true,
    "status": "queued",
    "trackId": "123456"
}
```

### GET /api/download/status/:trackId

Checks if a track is cached.

**Query Parameters:**

- `quality` (optional): Audio quality (default: HI_RES_LOSSLESS)

**Response:**

```json
{
    "status": "cached",
    "path": "/path/to/track.flac",
    "trackId": "123456"
}
```

### GET /health

Health check endpoint.

**Response:**

```json
{
    "status": "ok",
    "timestamp": "2026-02-02T12:00:00.000Z"
}
```

## Architecture

```
backend/
├── src/
│   ├── server.js              # Express server
│   ├── config.js              # Configuration management
│   ├── services/
│   │   ├── api-service.js     # API client for streaming services
│   │   ├── download-service.js # Download logic
│   │   └── cache-service.js   # Cache management
│   ├── routes/
│   │   └── download-routes.js # Express routes
│   └── utils/
│       └── helpers.js         # Utility functions
└── storage/
    └── tracks/                # Downloaded audio files
```

## How It Works

1. Frontend detects backend availability on startup
2. When a track is played, frontend sends a download trigger request with:
    - Track ID
    - Desired quality (from user settings)
    - API instances (from user settings)
3. Backend checks if track is already cached
4. If not cached, backend uses the provided API instances to download the track
5. Track is saved to `storage/tracks/{trackId}.{ext}`
6. Metadata is saved as `{trackId}.json` for cache management

This architecture allows multiple users to use the same backend with their own API instance preferences.

## Supported Formats

- FLAC (lossless)
- M4A (Apple Lossless)
- MP3
- OGG
- WAV

## Limitations

- Phase 1 does not support DASH manifest streams (XML-based)
- Only direct URL streams are supported
- No download queue management (processes all requests concurrently)

## Future Improvements

- DASH manifest support
- Download queue with concurrency limits
- LRU cache cleanup
- Metadata embedding with FFmpeg
- WebSocket for download progress tracking
- Rate limiting
- Authentication/API keys for public deployment
