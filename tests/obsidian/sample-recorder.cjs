/* Test-only bounded-memory evidence recorder. No Obsidian or product dependency. */
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { StringDecoder } = require('node:string_decoder');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');

const SCHEMA = 'obsidian-workspaces-sample-recorder-v1';
const MODE = 'append-only-streamed-final';
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const within = (parent, child) => {
  const part = path.relative(parent, child);
  return (
    part === '' || (part !== '..' && !part.startsWith(`..${path.sep}`) && !path.isAbsolute(part))
  );
};

function memoryObservation() {
  return {
    at: new Date().toISOString(),
    performanceMs: performance.now(),
    ...process.memoryUsage(),
  };
}

async function* journalLines(input, hash) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  // Readable async iteration applies backpressure while the final writer awaits
  // each row. A readline event queue could retain many already-decoded rows.
  for await (const chunk of input) {
    hash.update(chunk);
    pending += decoder.write(chunk);
    let start = 0;
    for (let end; (end = pending.indexOf('\n', start)) !== -1;) {
      yield pending.slice(start, end);
      start = end + 1;
    }
    pending = pending.slice(start);
  }
  pending += decoder.end();
  assert(!pending, 'Journal has a truncated final line.');
}

/** One active sample, numeric counters and one compact observation; never raw history. */
class SampleRecorder {
  static async create({ resultFile, vaultPath, runId, phase, identity }) {
    assert(/^[a-zA-Z0-9_-]{1,128}$/.test(runId), 'Invalid recorder run identity.');
    assert(path.isAbsolute(resultFile), 'Recorder output must be absolute.');
    const vault = await fs.realpath(vaultPath);
    await fs.mkdir(path.dirname(resultFile), { recursive: true });
    const directory = await fs.realpath(path.dirname(resultFile));
    assert(!within(vault, directory), 'Recorder evidence must resolve outside the vault.');
    const output = path.join(directory, path.basename(resultFile));
    try {
      const stat = await fs.lstat(output);
      assert(stat.isFile() && !stat.isSymbolicLink(), 'Recorder output must be a regular file.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const recorder = new SampleRecorder(output, runId, phase);
    // Exclusive creation preserves every earlier attempt, including a crash journal.
    recorder.handle = await fs.open(recorder.journalFile, 'wx');
    try {
      await recorder.append({
        kind: 'header',
        schema: SCHEMA,
        mode: MODE,
        runId,
        phase,
        startedAt: recorder.startedAt,
        identity,
      });
      await recorder.writeProgress();
      return recorder;
    } catch (error) {
      await recorder.handle.close();
      recorder.handle = null;
      throw error;
    }
  }

  constructor(resultFile, runId, phase) {
    this.resultFile = resultFile;
    this.runId = runId;
    this.phase = phase;
    this.startedAt = new Date().toISOString();
    this.journalFile = `${resultFile}.${runId}.samples.ndjson`;
    this.journalHash = createHash('sha256');
    this.startedSamples = 0;
    this.completedSamples = 0;
    this.failedSamples = 0;
    this.journalBytes = 0;
    this.rawSampleBytes = 0;
    this.serializationMs = 0;
    this.appendMs = 0;
    this.progressWriteMs = 0;
    this.progressWrites = 0;
    this.pending = null;
    this.lastObservation = null;
    this.lastSample = null;
    this.initialMemory = memoryObservation();
    this.poisoned = false;
    this.sealed = false;
    this.finalized = false;
  }

  async append(record, serialized) {
    assert(this.handle && !this.poisoned && !this.sealed, 'Recorder journal is not writable.');
    const line = `${serialized ?? JSON.stringify(record)}\n`;
    const started = performance.now();
    try {
      await this.handle.writeFile(line, 'utf8');
      this.journalHash.update(line);
      this.journalBytes += Buffer.byteLength(line);
      const elapsed = performance.now() - started;
      this.appendMs += elapsed;
      return elapsed;
    } catch (error) {
      this.poisoned = true;
      throw error;
    }
  }

  async checkpoint(metadata) {
    assert(!Object.hasOwn(metadata, 'samples'), 'Metadata must not retain detailed samples.');
    await this.append({ kind: 'metadata', metadata });
    await this.writeProgress();
  }

  async startSample(info) {
    assert(!this.pending, 'An unfinished sample already owns the recorder.');
    assert(info.index === this.startedSamples, 'Sample indices must be contiguous.');
    const identity = {
      index: info.index,
      scenario: info.scenario,
      temperature: info.temperature,
      fromId: info.fromId,
      toId: info.toId,
      direction: info.direction,
      startedAt: info.startedAt,
    };
    await this.append({ kind: 'sample-start', ...identity });
    this.pending = identity;
    this.startedSamples++;
  }

  async completeSample(sample) {
    assert(this.pending?.index === sample.index, 'Completion does not match its sample start.');
    assert(['passed', 'failed'].includes(sample.status), 'Cannot persist an unfinished sample.');
    const started = performance.now();
    // The JSON string is the immutable evidence boundary. Never serialize old
    // samples again while timing, and never retain the source object afterward.
    const serialized = JSON.stringify(sample);
    const serializationMs = performance.now() - started;
    this.serializationMs += serializationMs;
    const sampleBytes = Buffer.byteLength(serialized);
    const appendMs = await this.append(null, `{"kind":"sample","sample":${serialized}}`);
    const observation = {
      index: sample.index,
      sampleBytes,
      serializationMs,
      appendMs,
      memoryAfterAppend: memoryObservation(),
      excludedFromSwitchTiming: true,
    };
    await this.append({ kind: 'sample-recorded', observation });
    this.rawSampleBytes += sampleBytes;
    this.completedSamples++;
    if (sample.status === 'failed') this.failedSamples++;
    this.lastSample = { ...this.pending, status: sample.status };
    this.lastObservation = observation;
    this.pending = null;
    await this.writeProgress();
  }

  async writeProgress(error) {
    if (this.finalized) return;
    const started = performance.now();
    const progress = {
      kind: 'benchmark-progress',
      status: error ? 'failed' : 'running',
      recorderSchema: SCHEMA,
      recorderMode: MODE,
      runId: this.runId,
      phase: this.phase,
      startedAt: this.startedAt,
      updatedAt: new Date().toISOString(),
      journalFile: this.journalFile,
      startedSamples: this.startedSamples,
      completedSamples: this.completedSamples,
      failedSamples: this.failedSamples,
      currentSample: this.pending,
      lastSample: this.lastSample,
      lastObservation: this.lastObservation,
      journalBytes: this.journalBytes,
      complete: false,
      ...(error ? { error: { message: error.message ?? String(error) } } : {}),
    };
    const temporary = `${this.resultFile}.${this.runId}.progress.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(progress)}\n`, { flag: 'wx' });
    await fs.rename(temporary, this.resultFile);
    this.progressWrites++;
    this.progressWriteMs += performance.now() - started;
  }

  async finalize(metadata) {
    assert(!Object.hasOwn(metadata, 'samples'), 'Final metadata must not contain raw history.');
    assert(!this.pending && !this.poisoned, 'Incomplete sample journal cannot be finalized.');
    assert(['passed', 'failed'].includes(metadata.status), 'Final run status is missing.');
    assert(
      metadata.status !== 'passed' || (this.completedSamples > 0 && this.failedSamples === 0),
      'A run with absent or failed attempts cannot pass.',
    );
    const counts = {
      startedSamples: this.startedSamples,
      completedSamples: this.completedSamples,
      failedSamples: this.failedSamples,
    };
    await this.append({ kind: 'run-complete', counts, metadata });
    await this.handle.sync();
    await this.handle.close();
    this.handle = null;
    this.sealed = true;
    const journalSHA256 = this.journalHash.digest('hex');
    const proof = {
      schema: SCHEMA,
      mode: MODE,
      runId: this.runId,
      complete: true,
      ...counts,
      journalFile: this.journalFile,
      journalSHA256,
      journalBytes: this.journalBytes,
      rawSampleBytes: this.rawSampleBytes,
      rawSampleSerializations: this.completedSamples,
      retainedDetailedSamplesBetweenSwitches: 0,
      finalAssembly: 'streamed-after-timing',
      memoryScope: 'renderer process; observations outside switch timers; no forced GC',
      initialMemory: this.initialMemory,
      finalMemory: memoryObservation(),
      costs: {
        sampleSerializationMs: this.serializationMs,
        journalAppendMs: this.appendMs,
        compactProgressWriteMs: this.progressWriteMs,
        compactProgressWrites: this.progressWrites,
      },
    };
    await this.streamFinalReport(metadata, proof);
    this.finalized = true;
    return proof;
  }

  async streamFinalReport(metadata, proof) {
    const started = performance.now();
    const temporary = `${this.resultFile}.${this.runId}.final.partial`;
    const output = await fs.open(temporary, 'wx');
    const input = createReadStream(this.journalFile, { highWaterMark: 64 * 1024 });
    const hash = createHash('sha256');
    const sampleHash = createHash('sha256');
    let header = false;
    let ended = false;
    let current = null;
    let pendingSample = null;
    let starts = 0;
    let completed = 0;
    let failed = 0;
    try {
      await output.writeFile(`${JSON.stringify(metadata).slice(0, -1)},"samples":[`);
      for await (const line of journalLines(input, hash)) {
        assert(line && !ended, 'Trailing or empty journal data after completion.');
        const row = JSON.parse(line);
        if (!header) {
          assert(
            row.kind === 'header' &&
              row.schema === SCHEMA &&
              row.mode === MODE &&
              row.runId === this.runId,
            'Journal header does not match this recorder.',
          );
          header = true;
        } else if (row.kind === 'metadata') {
          assert(starts === 0, 'Metadata checkpoint appeared after sampling started.');
        } else if (row.kind === 'sample-start') {
          assert(
            !current && !pendingSample && row.index === starts,
            'Missing, duplicate or out-of-order sample start.',
          );
          current = row;
          starts++;
        } else if (row.kind === 'sample') {
          assert(
            current && !pendingSample && row.sample?.index === current.index,
            'Sample completion has no matching start.',
          );
          assert(
            ['passed', 'failed'].includes(row.sample.status),
            'Journal contains an unfinished sample.',
          );
          pendingSample = row.sample;
        } else if (row.kind === 'sample-recorded') {
          assert(
            current && pendingSample && row.observation?.index === current.index,
            'Sample observation is missing or out of order.',
          );
          pendingSample.recorderObservation = row.observation;
          const serialized = JSON.stringify(pendingSample);
          sampleHash.update(`${serialized}\n`);
          await output.writeFile(`${completed ? ',' : ''}${serialized}`);
          completed++;
          if (pendingSample.status === 'failed') failed++;
          current = null;
          pendingSample = null;
        } else if (row.kind === 'run-complete') {
          assert(!current && !pendingSample, 'Journal ended with an incomplete attempt.');
          assert(
            starts === completed &&
              starts === proof.startedSamples &&
              completed === proof.completedSamples &&
              failed === proof.failedSamples &&
              row.counts.startedSamples === starts &&
              row.counts.completedSamples === completed &&
              row.counts.failedSamples === failed &&
              JSON.stringify(row.metadata) === JSON.stringify(metadata),
            'Final journal counts or metadata disagree with complete evidence.',
          );
          ended = true;
        } else throw new Error(`Unknown journal record: ${row.kind}.`);
      }
      assert(header && ended, 'Journal is incomplete; no final report can be published.');
      assert(hash.digest('hex') === proof.journalSHA256, 'Journal bytes changed after recording.');
      proof.samplesSHA256 = sampleHash.digest('hex');
      proof.costs.finalAssemblyBeforePublicationMs = performance.now() - started;
      await output.writeFile(`],"recorder":${JSON.stringify(proof)}}\n`);
      await output.sync();
    } finally {
      input.destroy();
      await output.close();
    }
    await fs.rename(temporary, this.resultFile);
  }

  async closeIncomplete(error) {
    if (this.finalized) return;
    this.poisoned = true;
    if (this.handle) {
      await this.handle.close();
      this.handle = null;
    }
    await this.writeProgress(error ?? new Error('Benchmark ended without complete evidence.'));
  }
}

module.exports = { SampleRecorder, SCHEMA, MODE, memoryObservation };
