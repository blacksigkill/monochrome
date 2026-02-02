import fetch from 'node-fetch';
import { XMLParser } from 'fast-xml-parser';
import { logger } from '../logger.js';

export class DashDownloader {
    async downloadDashStream(manifestContent) {
        const parser = new XMLParser({
            ignoreAttributes: false,
            attributeNamePrefix: '@_',
        });

        const manifest = parser.parse(manifestContent);
        logger.debug('Parsed DASH manifest');

        const first = (value) => (Array.isArray(value) ? value[0] : value);

        // Navigate MPD structure
        const mpd = manifest.MPD;
        if (!mpd) {
            throw new Error('Invalid DASH manifest: no MPD element');
        }

        const period = first(mpd.Period);
        if (!period) {
            throw new Error('Invalid DASH manifest: no Period element');
        }

        const adaptationSet = first(period.AdaptationSet);
        if (!adaptationSet) {
            throw new Error('Invalid DASH manifest: no AdaptationSet element');
        }

        const representation = first(adaptationSet.Representation);
        if (!representation) {
            throw new Error('Invalid DASH manifest: no Representation element');
        }

        const segmentTemplate = representation.SegmentTemplate || adaptationSet.SegmentTemplate;
        if (!segmentTemplate) {
            throw new Error('Invalid DASH manifest: no SegmentTemplate');
        }

        // Extract base URL
        let baseURL = mpd.BaseURL || mpd['@_BaseURL'] || '';
        if (typeof baseURL === 'object' && baseURL['#text']) {
            baseURL = baseURL['#text'];
        }

        // Extract segment info
        const initTemplate = segmentTemplate['@_initialization'];
        const mediaTemplate = segmentTemplate['@_media'];
        const startNumber = parseInt(segmentTemplate['@_startNumber'] || '0');

        // Get timeline or duration
        const segmentTimeline = segmentTemplate.SegmentTimeline;
        const duration = parseInt(segmentTemplate['@_duration'] || '0');
        const timescale = parseInt(segmentTemplate['@_timescale'] || '1');

        let segmentCount;
        if (segmentTimeline && segmentTimeline.S) {
            const segments = Array.isArray(segmentTimeline.S) ? segmentTimeline.S : [segmentTimeline.S];
            segmentCount = segments.reduce((sum, s) => {
                const repeat = parseInt(s['@_r'] || '0');
                return sum + 1 + repeat;
            }, 0);
        } else if (duration) {
            // Estimate from total duration
            const periodDuration = mpd['@_mediaPresentationDuration'] || 'PT300S'; // default 5 min
            const seconds = this.parseDuration(periodDuration);
            const segmentDuration = duration / timescale;
            segmentCount = Math.ceil(seconds / segmentDuration);
        } else {
            throw new Error('Cannot determine segment count');
        }

        logger.info(`DASH info: ${segmentCount} segments, startNumber: ${startNumber}`);

        // Download initialization segment
        const initUrl = this.buildUrl(baseURL, initTemplate, {
            RepresentationID: representation['@_id'],
        });

        logger.debug(`Downloading init segment: ${initUrl}`);
        const initResponse = await fetch(initUrl);
        if (!initResponse.ok) {
            throw new Error(`Failed to download init segment: ${initResponse.status}`);
        }
        const initBuffer = await initResponse.arrayBuffer();
        const segments = [Buffer.from(initBuffer)];

        logger.debug(`Init segment downloaded: ${initBuffer.byteLength} bytes`);

        // Download media segments
        for (let i = 0; i < segmentCount; i++) {
            const segmentNumber = startNumber + i;
            const mediaUrl = this.buildUrl(baseURL, mediaTemplate, {
                RepresentationID: representation['@_id'],
                Number: segmentNumber,
            });

            try {
                const response = await fetch(mediaUrl);
                if (!response.ok) {
                    logger.warn(`Failed to download segment ${segmentNumber}: ${response.status}`);
                    continue;
                }

                const buffer = await response.arrayBuffer();
                segments.push(Buffer.from(buffer));

                if ((i + 1) % 10 === 0) {
                    logger.debug(`Downloaded ${i + 1}/${segmentCount} segments`);
                }
            } catch (error) {
                logger.warn(`Error downloading segment ${segmentNumber}: ${error.message}`);
                continue;
            }
        }

        logger.info(`Total segments downloaded: ${segments.length}`);

        // Concatenate all segments
        return Buffer.concat(segments);
    }

    buildUrl(baseURL, template, replacements) {
        let url = template;
        for (const [key, value] of Object.entries(replacements)) {
            url = url.replace(`$${key}$`, value);
        }
        return baseURL ? new URL(url, baseURL).href : url;
    }

    parseDuration(duration) {
        // Parse ISO 8601 duration like "PT300.096S"
        const match = duration.match(/PT(\d+(?:\.\d+)?)S/);
        return match ? parseFloat(match[1]) : 300;
    }
}
