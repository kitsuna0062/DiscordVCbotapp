'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { RelayMixer } = require('../relay-mixer');

const FRAME_BYTES = 3840;

function pcmFrame(sample) {
    return stereoFrame(sample, sample);
}

function stereoFrame(left, right) {
    const frame = Buffer.alloc(FRAME_BYTES);
    for (let offset = 0; offset < FRAME_BYTES; offset += 4) {
        frame.writeInt16LE(left, offset);
        frame.writeInt16LE(right, offset + 2);
    }
    return frame;
}

function waitForFrame(mixer, predicate, timeoutMs = 500) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            mixer.output.off('data', onData);
            reject(new Error('Timed out waiting for a mixed audio frame'));
        }, timeoutMs);
        const onData = frame => {
            if (!predicate(frame)) return;
            clearTimeout(timeout);
            mixer.output.off('data', onData);
            resolve(frame);
        };
        mixer.output.on('data', onData);
    });
}

test('mixes concurrent sources and applies per-source volume', async () => {
    const mixer = new RelayMixer();
    const first = new PassThrough();
    const second = new PassThrough();
    mixer.addSource('first', first);
    mixer.addSource('second', second, 50);
    const framePromise = waitForFrame(mixer, frame => frame.readInt16LE(0) > 0);

    try {
        first.write(pcmFrame(1000));
        second.write(pcmFrame(1000));
        const frame = await framePromise;
        assert.equal(frame.length, FRAME_BYTES);
        assert.equal(frame.readInt16LE(0), 750);
    } finally {
        first.destroy();
        second.destroy();
        mixer.destroy();
    }
});

test('converts stereo decoder frames to a correctly sized stereo output', async () => {
    const mixer = new RelayMixer();
    const input = new PassThrough();
    mixer.addSource('stereo', input);
    const framePromise = waitForFrame(mixer, frame => frame.readInt16LE(0) !== 0);

    try {
        input.write(stereoFrame(1000, 3000));
        const frame = await framePromise;
        assert.equal(frame.length, FRAME_BYTES);
        assert.equal(frame.readInt16LE(0), 2000);
        assert.equal(frame.readInt16LE(2), 2000);
    } finally {
        input.destroy();
        mixer.destroy();
    }
});

test('fills input gaps with silence and resumes with new PCM', async () => {
    const mixer = new RelayMixer();
    const input = new PassThrough();
    mixer.addSource('intermittent', input);

    try {
        const firstFrame = waitForFrame(mixer, frame => frame.readInt16LE(0) === 1000);
        input.write(pcmFrame(1000));
        await firstFrame;

        const silenceFrame = waitForFrame(mixer, frame => frame.readInt16LE(0) === 0);
        const silence = await silenceFrame;
        assert.equal(silence.length, FRAME_BYTES);

        const resumedFrame = waitForFrame(mixer, frame => frame.readInt16LE(0) === 2000);
        input.write(pcmFrame(2000));
        const resumed = await resumedFrame;
        assert.equal(resumed.readInt16LE(0), 2000);
    } finally {
        input.destroy();
        mixer.destroy();
    }
});

test('supports volumes above 100 percent without overflowing PCM samples', async () => {
    const mixer = new RelayMixer();
    const input = new PassThrough();
    mixer.addSource('amplified', input, 300);
    const framePromise = waitForFrame(mixer, frame => frame.readInt16LE(0) > 0);

    try {
        input.write(pcmFrame(20000));
        const frame = await framePromise;
        assert.equal(frame.readInt16LE(0), 32767);
    } finally {
        input.destroy();
        mixer.destroy();
    }
});
