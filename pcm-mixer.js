'use strict';

const { PassThrough } = require('stream');

const FRAME_BYTES = 3840;
const SAMPLE_COUNT = FRAME_BYTES / 2;
const PREBUFFER_BYTES = FRAME_BYTES * 3;
const MAX_QUEUED_BYTES = FRAME_BYTES * 10;

class PcmMixer {
    constructor() {
        this.output = new PassThrough({ highWaterMark: FRAME_BYTES * 10 });
        this.sources = new Map();
        this.timer = setInterval(() => this.mixFrame(), 20);
        this.timer.unref();
    }

    addSource(key, input, volume = 1) {
        this.removeSource(key);
        const source = { chunks: [], offset: 0, queuedBytes: 0, volume, started: false };
        source.onData = chunk => {
            const data = Buffer.from(chunk);
            source.chunks.push(data);
            source.queuedBytes += data.length;
            while (source.queuedBytes > MAX_QUEUED_BYTES && source.chunks.length > 0) {
                const excess = source.queuedBytes - MAX_QUEUED_BYTES;
                const first = source.chunks[0];
                const available = first.length - source.offset;
                const discard = Math.min(excess, available);
                source.offset += discard;
                source.queuedBytes -= discard;
                if (source.offset === first.length) {
                    source.chunks.shift();
                    source.offset = 0;
                }
            }
        };
        source.onEnd = () => this.removeSource(key);
        source.onError = () => this.removeSource(key);
        input.on('data', source.onData);
        input.once('end', source.onEnd);
        input.once('close', source.onEnd);
        input.once('error', source.onError);
        this.sources.set(key, { source, input });
    }

    setSourceVolume(key, volume) {
        const entry = this.sources.get(key);
        if (entry) entry.source.volume = volume;
    }

    removeSource(key) {
        const entry = this.sources.get(key);
        if (!entry) return;
        entry.input.off('data', entry.source.onData);
        entry.input.off('end', entry.source.onEnd);
        entry.input.off('close', entry.source.onEnd);
        entry.input.off('error', entry.source.onError);
        this.sources.delete(key);
    }

    mixFrame() {
        if (this.output.destroyed || this.output.readableLength >= FRAME_BYTES * 10) return;

        const mixed = new Int32Array(SAMPLE_COUNT);
        for (const { source } of this.sources.values()) {
            if (!source.started) {
                if (source.queuedBytes < PREBUFFER_BYTES) continue;
                source.started = true;
            }

            let bytesRead = 0;
            const frame = Buffer.alloc(FRAME_BYTES);
            while (bytesRead < FRAME_BYTES && source.chunks.length > 0) {
                const first = source.chunks[0];
                const available = first.length - source.offset;
                const count = Math.min(FRAME_BYTES - bytesRead, available);
                first.copy(frame, bytesRead, source.offset, source.offset + count);
                source.offset += count;
                source.queuedBytes -= count;
                bytesRead += count;
                if (source.offset === first.length) {
                    source.chunks.shift();
                    source.offset = 0;
                }
            }

            for (let i = 0; i < SAMPLE_COUNT; i++) {
                mixed[i] += Math.round(frame.readInt16LE(i * 2) * source.volume);
            }
            if (source.queuedBytes === 0) source.started = false;
        }

        const outputFrame = Buffer.allocUnsafe(FRAME_BYTES);
        for (let i = 0; i < SAMPLE_COUNT; i++) {
            outputFrame.writeInt16LE(Math.max(-32768, Math.min(32767, mixed[i])), i * 2);
        }
        this.output.write(outputFrame);
    }

    destroy() {
        clearInterval(this.timer);
        for (const key of this.sources.keys()) this.removeSource(key);
        this.output.destroy();
    }
}

module.exports = { PcmMixer };
