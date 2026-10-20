// Shortest attack/release ramp; anything faster than this clicks
const MIN_ENVELOPE_TIME = 0.005;

export class AudioEngine {
    constructor(tuningSystem) {
        this.tuningSystem = tuningSystem;
        this.audioContext = null;
        this.voiceBus = null;
        this.masterGain = null;
        this.limiter = null;
        this.clipper = null;
        this.filter = null;
        this.delay = null;
        this.reverb = null;
        this.analyser = null;
        this.lfo = null;
        this.lfoGain = null;
        this.voices = new Map();
        // Voices fading out after note-off; kept apart so the same key can be played again right away
        this.releasingVoices = new Set();
        
        this.params = {
            waveform: 'sawtooth',
            volume: 0.3,
            glideTime: 0.1,
            attack: 0.01,
            release: 0.2,
            filterFreq: 2000,
            filterQ: 1,
            filterType: 'lowpass',
            delayTime: 0.3,
            delayFeedback: 0.3,
            delayMix: 0,
            reverbMix: 0,
            lfoRate: 5,
            lfoDepth: 0,
            lfoTarget: 'none'
        };

        this.isRecording = false;
        this.mediaRecorder = null;
        this.recordingDestination = null;
        this.recordedChunks = [];
    }

    async initialize() {
        if (this.audioContext) return;

        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();

        // All voices sum here; its gain drops as notes are added so chords don't overload
        this.voiceBus = this.audioContext.createGain();

        this.filter = this.audioContext.createBiquadFilter();
        this.filter.type = this.params.filterType;
        this.filter.frequency.value = this.params.filterFreq;
        this.filter.Q.value = this.params.filterQ;

        this.delay = this.audioContext.createDelay(2);
        this.delay.delayTime.value = this.params.delayTime;
        this.delayFeedback = this.audioContext.createGain();
        this.delayFeedback.gain.value = this.params.delayFeedback;
        this.delayMix = this.audioContext.createGain();
        this.delayMix.gain.value = this.params.delayMix;

        this.reverb = this.audioContext.createConvolver();
        await this.createReverbImpulse();

        this.reverbMix = this.audioContext.createGain();
        this.reverbMix.gain.value = this.params.reverbMix;

        this.analyser = this.audioContext.createAnalyser();
        this.analyser.fftSize = 2048;
        // Default ceiling of -30dB pins loud bins at the top of the visualizer
        this.analyser.minDecibels = -100;
        this.analyser.maxDecibels = 0;

        this.lfo = this.audioContext.createOscillator();
        this.lfo.type = 'sine';
        this.lfo.frequency.value = this.params.lfoRate;
        this.lfoGain = this.audioContext.createGain();
        this.lfoGain.gain.value = this.params.lfoDepth;
        this.lfo.connect(this.lfoGain);
        this.lfo.start();

        this.masterGain = this.audioContext.createGain();
        this.masterGain.gain.value = this.params.volume;

        // Limiter holds loud passages (high volume, resonance, effects) just under full scale
        this.limiter = this.audioContext.createDynamicsCompressor();
        this.limiter.threshold.value = -3;
        this.limiter.knee.value = 0;
        this.limiter.ratio.value = 20;
        this.limiter.attack.value = 0.001;
        this.limiter.release.value = 0.1;

        // Soft clipper catches the transients the limiter is too slow for.
        // Input is halved so the curve spans ±2 instead of hard-clamping at ±1
        this.clipperDrive = this.audioContext.createGain();
        this.clipperDrive.gain.value = 0.5;
        this.clipper = this.audioContext.createWaveShaper();
        this.clipper.curve = this.createSoftClipCurve();

        // Voices: voiceBus -> filter
        this.voiceBus.connect(this.filter);

        // Main signal path: filter -> masterGain (dry signal)
        this.filter.connect(this.masterGain);
        
        // Effects: filter -> delay -> delayMix -> masterGain
        this.filter.connect(this.delay);
        this.delay.connect(this.delayFeedback);
        this.delayFeedback.connect(this.delay);
        this.delay.connect(this.delayMix);
        this.delayMix.connect(this.masterGain);
        
        // Reverb: filter -> reverb -> reverbMix -> masterGain
        this.filter.connect(this.reverb);
        this.reverb.connect(this.reverbMix);
        this.reverbMix.connect(this.masterGain);
        
        // Analyser for visualization
        this.filter.connect(this.analyser);
        
        // Output: masterGain -> limiter -> clipper -> destination
        this.masterGain.connect(this.limiter);
        this.limiter.connect(this.clipperDrive);
        this.clipperDrive.connect(this.clipper);
        this.clipper.connect(this.audioContext.destination);

        this.tuningSystem.addListener((tuningInfo, updates) => {
            this.handleTuningUpdate(updates);
        });

        console.log('Audio engine initialized');
    }

    async createReverbImpulse() {
        const sampleRate = this.audioContext.sampleRate;
        const length = sampleRate * 2;
        const impulse = this.audioContext.createBuffer(2, length, sampleRate);
        
        for (let channel = 0; channel < 2; channel++) {
            const channelData = impulse.getChannelData(channel);
            for (let i = 0; i < length; i++) {
                channelData[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2);
            }
        }
        this.reverb.buffer = impulse;
    }

    /**
     * Clipper curve over inputs -2..2: unity up to 0.9, then eases toward ±1 so output never exceeds full scale
     */
    createSoftClipCurve() {
        const samples = 4097;
        const knee = 0.9;
        const curve = new Float32Array(samples);
        for (let i = 0; i < samples; i++) {
            const x = (i / (samples - 1)) * 4 - 2;
            const magnitude = Math.abs(x);
            const shaped = magnitude <= knee
                ? magnitude
                : knee + (1 - knee) * Math.tanh((magnitude - knee) / (1 - knee));
            curve[i] = Math.sign(x) * shaped;
        }
        return curve;
    }

    /**
     * Play a note
     */
    async playNote(midiNote) {
        if (!this.audioContext) {
            await this.initialize();
        }

        // If note is already playing, don't restart it
        if (this.voices.has(midiNote)) {
            return;
        }

        // Add to tuning system and get the frequency
        const frequency = this.tuningSystem.addNote(midiNote);

        // Create voice
        const voice = this.createVoice(frequency);
        this.voices.set(midiNote, voice);
        this.updateVoiceBusGain();

        // Apply attack envelope
        const now = this.audioContext.currentTime;
        const attack = Math.max(this.params.attack, MIN_ENVELOPE_TIME);
        voice.gain.gain.setValueAtTime(0, now);
        voice.gain.gain.linearRampToValueAtTime(1, now + attack);
    }

    stopNote(midiNote) {
        if (!this.voices.has(midiNote)) return;

        const voice = this.voices.get(midiNote);
        this.voices.delete(midiNote);
        this.releasingVoices.add(voice);

        const now = this.audioContext.currentTime;
        const release = Math.max(this.params.release, MIN_ENVELOPE_TIME);

        voice.gain.gain.cancelScheduledValues(now);
        voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
        voice.gain.gain.linearRampToValueAtTime(0, now + release);

        setTimeout(() => {
            voice.oscillator.stop();
            voice.oscillator.disconnect();
            voice.gain.disconnect();
            this.releasingVoices.delete(voice);
            this.updateVoiceBusGain();
        }, release * 1000 + 100);

        this.tuningSystem.removeNote(midiNote);
    }

    /**
     * Scale the voice bus by 1/sqrt(voices) so a chord is about as loud as a single note
     */
    updateVoiceBusGain() {
        const count = Math.max(1, this.voices.size + this.releasingVoices.size);
        this.voiceBus.gain.setTargetAtTime(1 / Math.sqrt(count), this.audioContext.currentTime, 0.005);
    }

    createVoice(frequency) {
        const oscillator = this.audioContext.createOscillator();
        const gain = this.audioContext.createGain();

        oscillator.type = this.params.waveform;
        oscillator.frequency.setValueAtTime(frequency, this.audioContext.currentTime);
        
        if (this.lfo && this.lfoGain && this.params.lfoDepth > 0 && this.params.lfoTarget === 'pitch') {
            this.lfoGain.connect(oscillator.frequency);
        }
        
        oscillator.connect(gain);
        gain.connect(this.voiceBus);
        
        oscillator.start();

        return { oscillator, gain };
    }

    /**
     * Handle tuning updates (when fundamental changes and notes need to glide)
     */
    handleTuningUpdate(updates) {
        if (!updates || !this.audioContext) {
            return;
        }

        const now = this.audioContext.currentTime;

        for (const [midiNote, updateData] of updates) {
            const voice = this.voices.get(midiNote);
            if (!voice) continue;

            // Smoothly glide to the new frequency
            const currentFreq = updateData.oldFrequency;
            const targetFreq = updateData.frequency;

            // Cancel any scheduled changes and set current frequency
            voice.oscillator.frequency.cancelScheduledValues(now);
            voice.oscillator.frequency.setValueAtTime(currentFreq, now);
            
            // Exponential ramp for more natural pitch glide
            if (this.params.glideTime > 0) {
                voice.oscillator.frequency.exponentialRampToValueAtTime(
                    targetFreq, 
                    now + this.params.glideTime
                );
            } else {
                voice.oscillator.frequency.setValueAtTime(targetFreq, now);
            }
        }
    }

    /**
     * Set waveform for all oscillators
     */
    setWaveform(waveform) {
        this.params.waveform = waveform;
        
        // Update existing voices
        for (const voice of [...this.voices.values(), ...this.releasingVoices]) {
            voice.oscillator.type = waveform;
        }
    }

    /**
     * Set master volume
     */
    setVolume(volume) {
        this.params.volume = volume;
        if (this.masterGain) {
            const now = this.audioContext.currentTime;
            this.masterGain.gain.setValueAtTime(volume, now);
        }
    }

    /**
     * Set glide time in seconds
     */
    setGlideTime(seconds) {
        this.params.glideTime = seconds;
    }

    /**
     * Set attack time in seconds
     */
    setAttack(seconds) {
        this.params.attack = seconds;
    }

    setRelease(seconds) {
        this.params.release = seconds;
    }

    setFilterFreq(freq) {
        this.params.filterFreq = freq;
        if (this.filter) this.filter.frequency.setValueAtTime(freq, this.audioContext.currentTime);
    }

    setFilterQ(q) {
        this.params.filterQ = q;
        if (this.filter) this.filter.Q.setValueAtTime(q, this.audioContext.currentTime);
    }

    setFilterType(type) {
        this.params.filterType = type;
        if (this.filter) this.filter.type = type;
    }

    setDelayTime(time) {
        this.params.delayTime = time;
        if (this.delay) this.delay.delayTime.setValueAtTime(time, this.audioContext.currentTime);
    }

    setDelayFeedback(feedback) {
        this.params.delayFeedback = feedback;
        if (this.delayFeedback) this.delayFeedback.gain.setValueAtTime(feedback, this.audioContext.currentTime);
    }

    setDelayMix(mix) {
        this.params.delayMix = mix;
        if (this.delayMix) this.delayMix.gain.setValueAtTime(mix, this.audioContext.currentTime);
    }

    setReverbMix(mix) {
        this.params.reverbMix = mix;
        if (this.reverbMix) this.reverbMix.gain.setValueAtTime(mix, this.audioContext.currentTime);
    }

    setLfoRate(rate) {
        this.params.lfoRate = rate;
        if (this.lfo) this.lfo.frequency.setValueAtTime(rate, this.audioContext.currentTime);
    }

    setLfoDepth(depth) {
        this.params.lfoDepth = depth;
        const freqDepth = depth * 100;
        if (this.lfoGain) this.lfoGain.gain.setValueAtTime(freqDepth, this.audioContext.currentTime);
    }

    setLfoTarget(target) {
        this.params.lfoTarget = target;
    }

    getAnalyserData() {
        if (!this.analyser) return null;
        const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
        this.analyser.getByteFrequencyData(dataArray);
        return dataArray;
    }

    getParams() {
        return { ...this.params };
    }

    /**
     * Stop all notes
     */
    stopAll() {
        const allNotes = Array.from(this.voices.keys());
        for (const midiNote of allNotes) {
            this.stopNote(midiNote);
        }
    }

    async resume() {
        if (this.audioContext && this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }
    }

    startRecording() {
        if (this.isRecording || !this.audioContext) return;
        
        this.recordedChunks = [];
        this.recordingDestination = this.audioContext.createMediaStreamDestination();
        this.clipper.connect(this.recordingDestination);

        this.mediaRecorder = new MediaRecorder(this.recordingDestination.stream);
        this.mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) this.recordedChunks.push(e.data);
        };
        this.mediaRecorder.start();
        this.isRecording = true;
    }

    /**
     * Stop recording; resolves once the recorder has handed over its data and it is ready to download
     */
    stopRecording() {
        if (!this.isRecording || !this.mediaRecorder) return Promise.resolve();

        this.isRecording = false;
        return new Promise((resolve) => {
            // The final chunk arrives asynchronously, just before 'stop' fires
            this.mediaRecorder.onstop = () => {
                this.clipper.disconnect(this.recordingDestination);
                resolve();
            };
            this.mediaRecorder.stop();
        });
    }

    downloadRecording() {
        if (this.recordedChunks.length === 0) return;
        
        const blob = new Blob(this.recordedChunks, { type: 'audio/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'equal-justice-recording.webm';
        a.click();
        URL.revokeObjectURL(url);
        this.recordedChunks = [];
    }
}
