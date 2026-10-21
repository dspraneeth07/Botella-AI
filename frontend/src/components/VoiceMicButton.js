import React, { useState, useRef, useEffect } from 'react';
import { Mic } from 'lucide-react';

function VoiceMicButton({ onTranscript, onClose, disabled }) {
  const [isListening, setIsListening] = useState(false);
  const [isSupported, setIsSupported] = useState(true);
  const [interimText, setInterimText] = useState('');
  const recognitionRef = useRef(null);
  const onTranscriptRef = useRef(onTranscript);
  const onCloseRef = useRef(onClose);

  // Keep callback refs up to date without re-running the effect
  useEffect(() => {
    onTranscriptRef.current = onTranscript;
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setIsSupported(false);
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onresult = (event) => {
      let finalTranscript = '';
      let interim = '';

      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalTranscript += result[0].transcript;
        } else {
          interim += result[0].transcript;
        }
      }

      if (finalTranscript) {
        onTranscriptRef.current(finalTranscript);
        setInterimText('');
        setIsListening(false);
      } else {
        setInterimText(interim);
      }
    };

    recognition.onerror = () => {
      setIsListening(false);
      setInterimText('');
      onCloseRef.current?.();
    };

    recognition.onend = () => {
      setIsListening(false);
      setInterimText('');
      onCloseRef.current?.();
    };

    recognitionRef.current = recognition;

    return () => {
      recognition.abort();
    };
  }, []);

  const startListening = () => {
    if (!recognitionRef.current) return;
    setInterimText('');
    recognitionRef.current.start();
    setIsListening(true);
  };

  const stopListening = () => {
    if (!recognitionRef.current) return;
    recognitionRef.current.stop();
    setIsListening(false);
    setInterimText('');
    onCloseRef.current?.();
  };

  // Unsupported browsers (Firefox <121, older Safari, etc.) - render a disabled
  // button with an explanatory tooltip instead of hiding the button entirely, so
  // users understand why voice input isn't available on their browser.
  if (!isSupported) {
    return (
      <button
        className="chat-mic-btn"
        disabled
        aria-label="Voice input not supported in this browser"
        title="Voice input isn't supported in this browser. Try Chrome, Edge, Safari, or Firefox 121+."
      >
        <Mic size={18} />
      </button>
    );
  }

  return (
    <>
      {/* Mic button in input area */}
      <button
        className="chat-mic-btn"
        onClick={startListening}
        disabled={disabled || isListening}
        title="Voice input"
      >
        <Mic size={18} />
      </button>

      {/* Listening popup overlay - tap anywhere to close */}
      {isListening && (
        <div className="mic-overlay" onClick={stopListening}>
          <div className="mic-popup" onClick={(e) => e.stopPropagation()}>

            <div className="mic-pulse-ring">
              <div className="mic-pulse-circle" />
              <div className="mic-icon-circle">
                <Mic size={44} />
              </div>
            </div>

            <p className="mic-popup-label">Listening...</p>

            <p className="mic-popup-transcript">
              {interimText || 'Start speaking...'}
            </p>

            <p className="mic-popup-hint">Tap anywhere to close</p>
          </div>
        </div>
      )}
    </>
  );
}

export default VoiceMicButton;
