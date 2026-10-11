'use strict';

const { EventEmitter } = require('node:events');
const { Mixer } = require('audio-mixer');

const FRAME_BYTES = 3840;
const MIXER_INPUT_FRAME_BYTES = FRAME_BYTES / 2;
const FRAME_INTERVAL_MS = 20;
const MAX_QUEUED_BYTES = FRAME_BYTES * 10;
const SILENCE_FRAME = Buffer.alloc(MIXER_INPUT_FRAME_BYTES);

class RelayMixer extends EventEmitter {
    constructor() {
        super();
        this.output = new Mixer({
            channels: 2,
            bitDepth: 16,
            sampleRate: 48000
        });
        this.sources = new Map();
        this.destroyed = false;
        this.idleInput = null;
        this.timer = setInterval(() => {
            if (this.sources.size === 0) {
                this.idleInput?.write(SILENCE_FRAME);
                return;
            }
            for (const { source } of this.sources.values()) this.writeFrame(source);
        }, FRAME_INTERVAL_MS);
        this.timer.unref();
        this.startIdleOutput();
    }

    createInput(volume = 100) {
        const input = this.output.input({
            channels: 1,
            bitDepth: 16,
            sampleRate: 48000,
            clearInterval: 100
        });
        input.setVolume(Math.min(volume, 100));
        return input;
    }

    startIdleOutput() {
        if (this.destroyed || this.idleInput || this.sources.size > 0) return;

        this.idleInput = this.createInput();
        this.idleInput.write(SILENCE_FRAME);
    }

    stopIdleOutput() {
        if (!this.idleInput) return;

        this.output.removeInput(this.idleInput);
        this.idleInput.destroy();
        this.idleInput = null;
    }

    addSource(key, stream, volume = 100) {
        this.removeSource(key);
        this.stopIdleOutput();

        const source = {
            input: this.createInput(volume),
            chunks: [],
            offset: 0,
            queuedBytes: 0,
            volume
        };
        source.onData = chunk => {
            const data = Buffer.from(chunk);
            source.chunks.push(data);
            source.queuedBytes += data.length;
            while (source.queuedBytes > MAX_QUEUED_BYTES && source.chunks.length > 0) {
                const excess = source.queuedBytes - MAX_QUEUED_BYTES;
                const first = source.chunks[0];
                const discard = Math.min(excess, first.length - source.offset);
                source.offset += discard;
                source.queuedBytes -= discard;
                if (source.offset === first.length) {
                    source.chunks.shift();
                    source.offset = 0;
                }
            }
        };
        source.onError = error => {
            this.emit('sourceError', key, error);
            this.removeSource(key);
        };
        stream.on('data', source.onData);
        stream.on('error', source.onError);
        this.sources.set(key, { source, stream });

        source.input.write(SILENCE_FRAME);
    }

    writeFrame(source) {
        const frame = Buffer.alloc(FRAME_BYTES);
        let bytesWritten = 0;
        while (bytesWritten < FRAME_BYTES && source.chunks.length > 0) {
            const first = source.chunks[0];
            const available = first.length - source.offset;
            const count = Math.min(FRAME_BYTES - bytesWritten, available);
            first.copy(frame, bytesWritten, source.offset, source.offset + count);
            source.offset += count;
            source.queuedBytes -= count;
            bytesWritten += count;
            if (source.offset === first.length) {
                source.chunks.shift();
                source.offset = 0;
            }
        }

        const monoFrame = Buffer.alloc(MIXER_INPUT_FRAME_BYTES);
        for (let sampleIndex = 0; sampleIndex < MIXER_INPUT_FRAME_BYTES / 2; sampleIndex++) {
            const stereoOffset = sampleIndex * 4;
            const sample = Math.round((frame.readInt16LE(stereoOffset) + frame.readInt16LE(stereoOffset + 2)) / 2);
            const gainedSample = source.volume > 100
                ? Math.round(sample * source.volume / 100)
                : sample;
            monoFrame.writeInt16LE(Math.max(-32768, Math.min(32767, gainedSample)), sampleIndex * 2);
        }
        source.input.write(monoFrame);
    }

    setSourceVolume(key, volume) {
        const source = this.sources.get(key)?.source;
        if (!source) return;

        source.volume = Math.max(0, Math.min(300, volume));
        source.input.setVolume(Math.min(source.volume, 100));
    }

    removeSource(key) {
        const entry = this.sources.get(key);
        if (!entry) return;

        const { source, stream } = entry;
        stream.off('data', source.onData);
        stream.off('error', source.onError);
        this.output.removeInput(source.input);
        source.input.destroy();
        this.sources.delete(key);
        this.startIdleOutput();
    }

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        clearInterval(this.timer);
        this.stopIdleOutput();
        for (const key of this.sources.keys()) this.removeSource(key);
        this.output.close();
        this.output.destroy();
    }
}

module.exports = { RelayMixer };
