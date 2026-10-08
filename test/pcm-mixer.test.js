'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { PcmMixer } = require('../pcm-mixer');

const FRAME_BYTES = 3840;

function pcmFrame(sample) {
    const frame = Buffer.alloc(FRAME_BYTES);
    for (let offset = 0; offset < FRAME_BYTES; offset += 2) {
        frame.writeInt16LE(sample, offset);
    }
    return frame;
}

test('mixes simultaneous input sources and clamps overflow', async () => {
    const mixer = new PcmMixer();
    const first = new PassThrough();
    const second = new PassThrough();
    mixer.addSource('first', first);
    mixer.addSource('second', second);

    try {
        first.write(pcmFrame(20000));
        second.write(pcmFrame(20000));
        await new Promise(resolve => setImmediate(resolve));
        mixer.mixFrame();

        const output = mixer.output.read(FRAME_BYTES);
        assert.ok(output);
        assert.equal(output.readInt16LE(0), 32767);
    } finally {
        first.destroy();
        second.destroy();
        mixer.destroy();
    }
});

test('applies per-source volume while mixing', async () => {
    const mixer = new PcmMixer();
    const input = new PassThrough();
    mixer.addSource('quiet', input, 0.5);

    try {
        input.write(pcmFrame(1000));
        await new Promise(resolve => setImmediate(resolve));
        mixer.mixFrame();

        const output = mixer.output.read(FRAME_BYTES);
        assert.ok(output);
        assert.equal(output.readInt16LE(0), 500);
    } finally {
        input.destroy();
        mixer.destroy();
    }
});
