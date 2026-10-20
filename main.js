/**
 * Main application for Equal Justice Synthesizer
 */

import { TuningSystem } from './tuning.js';
import { AudioEngine } from './audioEngine.js';

class EqualPerfectSynth {
    constructor() {
        this.tuningSystem = new TuningSystem();
        this.audioEngine = new AudioEngine(this.tuningSystem);
        
        // Keyboard mapping (computer keyboard to MIDI notes)
        // Starting from C3 (MIDI 48)
        this.keyMap = {
            'a': 48,  // C3
            'w': 49,  // C#3
            's': 50,  // D3
            'e': 51,  // D#3
            'd': 52,  // E3
            'f': 53,  // F3
            't': 54,  // F#3
            'g': 55,  // G3
            'y': 56,  // G#3
            'h': 57,  // A3
            'u': 58,  // A#3
            'j': 59,  // B3
            'k': 60,  // C4
            'o': 61,  // C#4
            'l': 62,  // D4
            ';': 63,  // D#4
            "'": 64,  // E4
            ']': 65,  // F4
        };

        this.activeKeys = new Set();
        this.activeMidiNotes = new Set();
        this.init();
    }

    async init() {
        this.setupStartOverlay();
        this.setupKeyboard();
        this.setupControls();
        this.setupTuningDisplay();
        this.setupKeyboardInput();
        this.setupMidiInput();
        this.setupVisualization();
        
        console.log('Equal Justice Synthesizer ready!');
    }

    setupVisualization() {
        const canvas = document.getElementById('vizCanvas');
        const ctx = canvas.getContext('2d');
        
        const draw = () => {
            requestAnimationFrame(draw);
            
            const dataArray = this.audioEngine.getAnalyserData();
            if (!dataArray) return;
            
            ctx.fillStyle = '#1a1a1a';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            
            const barWidth = (canvas.width / dataArray.length) * 2.5;
            let x = 0;
            
            for (let i = 0; i < dataArray.length; i++) {
                const barHeight = (dataArray[i] / 255) * canvas.height;
                
                const gradient = ctx.createLinearGradient(0, canvas.height, 0, canvas.height - barHeight);
                gradient.addColorStop(0, '#ff3366');
                gradient.addColorStop(1, '#00ffaa');
                
                ctx.fillStyle = gradient;
                ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);
                
                x += barWidth + 1;
                if (x > canvas.width) break;
            }
        };
        
        draw();
    }

    setupStartOverlay() {
        const overlay = document.getElementById('startOverlay');
        
        const startAudio = async () => {
            await this.audioEngine.initialize();
            await this.audioEngine.resume();
            overlay.classList.add('hidden');
            setTimeout(() => overlay.remove(), 500);
        };

        overlay.addEventListener('click', startAudio);
        overlay.addEventListener('touchstart', startAudio);
    }

    setupMidiInput() {
        const midiStatusEl = document.getElementById('midiStatus');
        
        if (!navigator.requestMIDIAccess) {
            midiStatusEl.textContent = 'Not supported';
            return;
        }

        navigator.requestMIDIAccess().then((midiAccess) => {
            this.midiInputs = new Map();
            midiStatusEl.textContent = 'No device';

            midiAccess.onstatechange = () => {
                this.updateMidiInputs(midiAccess, midiStatusEl);
            };

            this.updateMidiInputs(midiAccess, midiStatusEl);
        }).catch((err) => {
            midiStatusEl.textContent = 'Access denied';
            console.log('MIDI access denied:', err);
        });
    }

    updateMidiInputs(midiAccess, statusEl) {
        const inputs = Array.from(midiAccess.inputs.values());
        
        if (inputs.length === 0) {
            statusEl.textContent = 'No device';
            return;
        }

        for (const input of inputs) {
            if (!this.midiInputs.has(input)) {
                input.onmidimessage = (e) => this.handleMidiMessage(e);
                this.midiInputs.set(input, true);
                statusEl.textContent = input.name;
                console.log('MIDI input connected:', input.name);
            }
        }
    }

    handleMidiMessage(event) {
        const [status, note, velocity] = event.data;
        const command = status & 0xf0;

        if (command === 0x90 && velocity > 0) {
            this.noteOn(note);
            this.highlightKey(note, true);
            this.activeMidiNotes.add(note);
        } else if (command === 0x80 || (command === 0x90 && velocity === 0)) {
            this.noteOff(note);
            this.highlightKey(note, false);
            this.activeMidiNotes.delete(note);
        }
    }

    /**
     * Generate and setup the visual keyboard
     */
    setupKeyboard() {
        const keyboard = document.getElementById('keyboard');
        keyboard.innerHTML = '';

        const startNote = 48;
        const numOctaves = 3;
        const notesPerOctave = 12;

        const whiteKeyPattern = [0, 2, 4, 5, 7, 9, 11]; // C, D, E, F, G, A, B
        const blackKeyPattern = [1, 3, 6, 8, 10]; // C#, D#, F#, G#, A#
        const whiteKeyWidth = 42; // 40px + 2px margin
        const blackKeyOffsets = {
            1: 29,   // C# - between C(0) and D(42)
            3: 71,   // D# - between D(42) and E(84)
            6: 155,  // F# - between F(126) and G(168)
            8: 197,  // G# - between G(168) and A(210)
            10: 239  // A# - between A(210) and B(252)
        };

        // Create white keys (21 keys for 3 octaves)
        for (let octave = 0; octave < numOctaves; octave++) {
            for (const offset of whiteKeyPattern) {
                const midiNote = startNote + (octave * notesPerOctave) + offset;
                const key = this.createKey(midiNote, false);
                keyboard.appendChild(key);
            }
        }

        // Create black keys (positioned absolutely)
        for (let octave = 0; octave < numOctaves; octave++) {
            for (const offset of blackKeyPattern) {
                const midiNote = startNote + (octave * notesPerOctave) + offset;
                const basePosition = blackKeyOffsets[offset] + (octave * (whiteKeyWidth * 7));
                const key = this.createKey(midiNote, true, basePosition);
                keyboard.appendChild(key);
            }
        }
    }

    /**
     * Create a single key element
     */
    createKey(midiNote, isBlack, leftPosition = null) {
        const key = document.createElement('div');
        key.className = `key ${isBlack ? 'black' : 'white'}`;
        key.dataset.note = midiNote;

        if (isBlack) {
            key.style.left = `${leftPosition}px`;
        }

        // Add note label
        const noteName = this.tuningSystem.midiToNoteName(midiNote);
        const label = document.createElement('span');
        label.textContent = noteName;
        key.appendChild(label);

        // Mouse events
        key.addEventListener('mousedown', (e) => {
            e.preventDefault();
            this.noteOn(midiNote);
            key.classList.add('active');
        });

        key.addEventListener('mouseup', () => {
            this.noteOff(midiNote);
            key.classList.remove('active');
        });

        key.addEventListener('mouseleave', () => {
            if (key.classList.contains('active')) {
                this.noteOff(midiNote);
                key.classList.remove('active');
            }
        });

        // Touch events for mobile
        key.addEventListener('touchstart', (e) => {
            e.preventDefault();
            this.noteOn(midiNote);
            key.classList.add('active');
        });

        key.addEventListener('touchend', (e) => {
            e.preventDefault();
            this.noteOff(midiNote);
            key.classList.remove('active');
        });

        return key;
    }

    /**
     * Setup control panel event listeners
     */
    setupControls() {
        // Waveform selector
        const waveformSelect = document.getElementById('waveform');
        waveformSelect.addEventListener('change', (e) => {
            this.audioEngine.setWaveform(e.target.value);
        });

        // Glide time
        const glideTime = document.getElementById('glideTime');
        const glideTimeValue = document.getElementById('glideTimeValue');
        glideTime.addEventListener('input', (e) => {
            const ms = parseInt(e.target.value);
            const seconds = ms / 1000;
            this.audioEngine.setGlideTime(seconds);
            glideTimeValue.textContent = `${ms}ms`;
        });

        // Volume
        const volume = document.getElementById('volume');
        const volumeValue = document.getElementById('volumeValue');
        volume.addEventListener('input', (e) => {
            const percent = parseInt(e.target.value);
            const normalized = percent / 100;
            this.audioEngine.setVolume(normalized);
            volumeValue.textContent = `${percent}%`;
        });

        // Attack
        const attack = document.getElementById('attack');
        const attackValue = document.getElementById('attackValue');
        attack.addEventListener('input', (e) => {
            const ms = parseInt(e.target.value);
            const seconds = ms / 1000;
            this.audioEngine.setAttack(seconds);
            attackValue.textContent = `${ms}ms`;
        });

        // Release
        const release = document.getElementById('release');
        const releaseValue = document.getElementById('releaseValue');
        release.addEventListener('input', (e) => {
            const ms = parseInt(e.target.value);
            const seconds = ms / 1000;
            this.audioEngine.setRelease(seconds);
            releaseValue.textContent = `${ms}ms`;
        });

        // Filter controls
        const filterFreq = document.getElementById('filterFreq');
        const filterFreqValue = document.getElementById('filterFreqValue');
        filterFreq.addEventListener('input', (e) => {
            const freq = parseInt(e.target.value);
            this.audioEngine.setFilterFreq(freq);
            const display = freq >= 1000 ? `${(freq/1000).toFixed(1)}kHz` : `${freq}Hz`;
            filterFreqValue.textContent = display;
        });

        const filterQ = document.getElementById('filterQ');
        const filterQValue = document.getElementById('filterQValue');
        filterQ.addEventListener('input', (e) => {
            const q = parseFloat(e.target.value);
            this.audioEngine.setFilterQ(q);
            filterQValue.textContent = q.toFixed(1);
        });

        // Delay controls
        const delayMix = document.getElementById('delayMix');
        const delayMixValue = document.getElementById('delayMixValue');
        delayMix.addEventListener('input', (e) => {
            const mix = parseInt(e.target.value) / 100;
            this.audioEngine.setDelayMix(mix);
            delayMixValue.textContent = `${Math.round(mix * 100)}%`;
        });

        // Reverb controls
        const reverbMix = document.getElementById('reverbMix');
        const reverbMixValue = document.getElementById('reverbMixValue');
        reverbMix.addEventListener('input', (e) => {
            const mix = parseInt(e.target.value) / 100;
            this.audioEngine.setReverbMix(mix);
            reverbMixValue.textContent = `${Math.round(mix * 100)}%`;
        });

        // LFO controls
        const lfoRate = document.getElementById('lfoRate');
        const lfoRateValue = document.getElementById('lfoRateValue');
        lfoRate.addEventListener('input', (e) => {
            const rate = parseFloat(e.target.value);
            this.audioEngine.setLfoRate(rate);
            lfoRateValue.textContent = `${rate.toFixed(1)}Hz`;
        });

        const lfoDepth = document.getElementById('lfoDepth');
        const lfoDepthValue = document.getElementById('lfoDepthValue');
        lfoDepth.addEventListener('input', (e) => {
            const depth = parseInt(e.target.value) / 100;
            this.audioEngine.setLfoDepth(depth);
            lfoDepthValue.textContent = `${Math.round(depth * 100)}%`;
        });

        const lfoTarget = document.getElementById('lfoTarget');
        lfoTarget.addEventListener('change', (e) => {
            this.audioEngine.setLfoTarget(e.target.value);
        });

        // Tuning system selector
        const tuningSystem = document.getElementById('tuningSystem');
        const ratiosPanel = document.querySelector('.ratios-panel');
        tuningSystem.addEventListener('change', (e) => {
            this.tuningSystem.setTuningSystem(e.target.value);
            // Show custom ratios panel only when custom is selected
            if (e.target.value === 'custom') {
                ratiosPanel.classList.add('visible');
            } else {
                ratiosPanel.classList.remove('visible');
            }
        });

        // Recording
        const recordBtn = document.getElementById('recordBtn');
        recordBtn.addEventListener('click', async () => {
            if (this.audioEngine.isRecording) {
                recordBtn.classList.remove('active');
                recordBtn.textContent = '● REC';
                await this.audioEngine.stopRecording();
                this.audioEngine.downloadRecording();
            } else {
                this.audioEngine.startRecording();
                recordBtn.classList.add('active');
                recordBtn.textContent = '■ STOP';
            }
        });

        // Preset system
        const savePresetBtn = document.getElementById('savePresetBtn');
        savePresetBtn.addEventListener('click', () => {
            const preset = {
                waveform: document.getElementById('waveform').value,
                volume: document.getElementById('volume').value,
                glideTime: document.getElementById('glideTime').value,
                attack: document.getElementById('attack').value,
                release: document.getElementById('release').value,
                filterFreq: document.getElementById('filterFreq').value,
                filterQ: document.getElementById('filterQ').value,
                delayMix: document.getElementById('delayMix').value,
                reverbMix: document.getElementById('reverbMix').value,
                lfoRate: document.getElementById('lfoRate').value,
                lfoDepth: document.getElementById('lfoDepth').value,
                lfoTarget: document.getElementById('lfoTarget').value,
                tuningSystem: document.getElementById('tuningSystem').value
            };
            const blob = new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'equal-justice-preset.json';
            a.click();
            URL.revokeObjectURL(url);
        });

        const loadPresetBtn = document.getElementById('loadPresetBtn');
        loadPresetBtn.addEventListener('click', () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json';
            input.onchange = (e) => {
                const file = e.target.files[0];
                const reader = new FileReader();
                reader.onload = (ev) => {
                    const preset = JSON.parse(ev.target.result);
                    this.applyPreset(preset);
                };
                reader.readAsText(file);
            };
            input.click();
        });

        // Custom ratios
        const applyRatios = document.getElementById('applyRatios');
        applyRatios.addEventListener('click', () => {
            try {
                const ratios = {};
                for (let i = 1; i <= 11; i++) {
                    const input = document.getElementById(`ratio${i}`);
                    const val = input.value.trim();
                    if (val.includes('/')) {
                        const [num, denom] = val.split('/').map(x => parseFloat(x));
                        ratios[i - 1] = num / denom;
                    } else {
                        ratios[i - 1] = parseFloat(val);
                    }
                }
                ratios[12] = 2;
                this.tuningSystem.setCustomRatios(ratios);
                console.log('Custom ratios applied:', ratios);
            } catch (e) {
                console.error('Invalid ratio format:', e);
                alert('Invalid ratio format. Use decimals (1.5) or fractions (3/2)');
            }
        });
    }

    applyPreset(preset) {
        const setValue = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.value = value;
        };

        setValue('waveform', preset.waveform);
        setValue('volume', preset.volume);
        setValue('glideTime', preset.glideTime);
        setValue('attack', preset.attack);
        setValue('release', preset.release);
        setValue('filterFreq', preset.filterFreq);
        setValue('filterQ', preset.filterQ);
        setValue('delayMix', preset.delayMix);
        setValue('reverbMix', preset.reverbMix);
        setValue('lfoRate', preset.lfoRate);
        setValue('lfoDepth', preset.lfoDepth);
        setValue('lfoTarget', preset.lfoTarget);
        setValue('tuningSystem', preset.tuningSystem);

        this.audioEngine.setWaveform(preset.waveform);
        this.audioEngine.setVolume(preset.volume / 100);
        this.audioEngine.setGlideTime(preset.glideTime / 1000);
        this.audioEngine.setAttack(preset.attack / 1000);
        this.audioEngine.setRelease(preset.release / 1000);
        this.audioEngine.setFilterFreq(parseInt(preset.filterFreq));
        this.audioEngine.setFilterQ(parseFloat(preset.filterQ));
        this.audioEngine.setDelayMix(parseInt(preset.delayMix) / 100);
        this.audioEngine.setReverbMix(parseInt(preset.reverbMix) / 100);
        this.audioEngine.setLfoRate(parseFloat(preset.lfoRate));
        this.audioEngine.setLfoDepth(parseInt(preset.lfoDepth) / 100);
        this.audioEngine.setLfoTarget(preset.lfoTarget);
        this.tuningSystem.setTuningSystem(preset.tuningSystem);
    }

    /**
     * Setup tuning information display
     */
    setupTuningDisplay() {
        this.tuningSystem.addListener((tuningInfo) => {
            const fundamentalEl = document.getElementById('fundamental');
            const activeNotesEl = document.getElementById('activeNotes');
            const notesListEl = document.getElementById('notesList');
            const tuningModeEl = document.getElementById('tuningMode');

            if (tuningInfo.fundamental) {
                const freqStr = tuningInfo.fundamentalFreq.toFixed(1);
                fundamentalEl.textContent = `${tuningInfo.fundamental} (${freqStr}Hz)`;
            } else {
                fundamentalEl.textContent = '—';
            }

            activeNotesEl.textContent = tuningInfo.activeCount;

            tuningModeEl.textContent = tuningInfo.activeCount > 1 ? 'HYBRID' : '12TET';

            if (tuningInfo.activeCount === 0) {
                notesListEl.innerHTML = '<div class="note-empty">press keys to play</div>';
                return;
            }

            notesListEl.innerHTML = '';
            for (const note of tuningInfo.notes) {
                const noteItem = document.createElement('div');
                noteItem.className = 'note-item';
                if (note.isLowest) {
                    noteItem.classList.add('is-fundamental');
                }
                const ratioText = note.isLowest ? '12TET' : note.ratio.toFixed(3);
                noteItem.innerHTML = `
                    <span class="note-name">${note.noteName}</span>
                    <span class="note-freq">${note.frequency.toFixed(1)} Hz</span>
                    <span class="note-ratio">${ratioText}</span>
                `;
                notesListEl.appendChild(noteItem);
            }

            if (tuningInfo.activeCount > 0) {
                console.log('Tuning Info:', tuningInfo);
            }
        });
    }

    /**
     * Setup computer keyboard input
     */
    setupKeyboardInput() {
        window.addEventListener('keydown', (e) => {
            // Prevent repeat events while key is held
            if (e.repeat) return;

            const key = e.key.toLowerCase();
            if (this.keyMap[key]) {
                const midiNote = this.keyMap[key];
                if (!this.activeKeys.has(key)) {
                    this.activeKeys.add(key);
                    this.noteOn(midiNote);
                    this.highlightKey(midiNote, true);
                }
            }
        });

        window.addEventListener('keyup', (e) => {
            const key = e.key.toLowerCase();
            if (this.keyMap[key]) {
                const midiNote = this.keyMap[key];
                this.activeKeys.delete(key);
                this.noteOff(midiNote);
                this.highlightKey(midiNote, false);
            }
        });

        // Stop all notes if window loses focus
        window.addEventListener('blur', () => {
            for (const key of this.activeKeys) {
                const midiNote = this.keyMap[key];
                this.noteOff(midiNote);
                this.highlightKey(midiNote, false);
            }
            this.activeKeys.clear();

            for (const midiNote of this.activeMidiNotes) {
                this.noteOff(midiNote);
                this.highlightKey(midiNote, false);
            }
            this.activeMidiNotes.clear();
        });
    }

    /**
     * Highlight/unhighlight a key on the visual keyboard
     */
    highlightKey(midiNote, active) {
        const keyEl = document.querySelector(`.key[data-note="${midiNote}"]`);
        if (keyEl) {
            if (active) {
                keyEl.classList.add('active');
            } else {
                keyEl.classList.remove('active');
            }
        }
    }

    /**
     * Note on event
     */
    async noteOn(midiNote) {
        await this.audioEngine.resume(); // Resume audio context if suspended
        await this.audioEngine.playNote(midiNote);
    }

    /**
     * Note off event
     */
    noteOff(midiNote) {
        this.audioEngine.stopNote(midiNote);
    }
}

// Initialize the synthesizer when the page loads
window.addEventListener('DOMContentLoaded', () => {
    window.synth = new EqualPerfectSynth();
});
