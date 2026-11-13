import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Animated,
  Easing,
} from 'react-native';
import { WebView } from 'react-native-webview';
import type { WebViewMessageEvent } from 'react-native-webview';
import { useMicrophonePermissions } from 'expo-camera';
import { COLORS, SPACING } from '@constants/index';
import { parseVoiceInput } from '@utils/index';
import type { ParsedVoiceItem } from '../utils/voiceParser';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../hooks/useTheme';

const SPEECH_HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body>
  <script>
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    let recognition = null;

    function post(payload) {
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify(payload));
      }
    }

    function start(lang) {
      if (!SpeechRecognition) {
        post({ type: 'unavailable' });
        return;
      }
      try {
        if (recognition) {
          recognition.onend = null;
          recognition.stop();
        }
        recognition = new SpeechRecognition();
        recognition.lang = lang || 'fil-PH';
        recognition.interimResults = true;
        recognition.continuous = false;
        recognition.maxAlternatives = 1;
        recognition.onstart = function () {
          post({ type: 'started' });
        };
        recognition.onresult = function (event) {
          var text = '';
          var isFinal = false;
          for (var i = event.resultIndex; i < event.results.length; i++) {
            text += event.results[i][0].transcript;
            if (event.results[i].isFinal) {
              isFinal = true;
            }
          }
          post({ type: 'result', text: text.trim(), isFinal: isFinal });
        };
        recognition.onerror = function (event) {
          post({ type: 'error', error: event.error || 'unknown' });
        };
        recognition.onend = function () {
          post({ type: 'end' });
        };
        recognition.start();
      } catch (err) {
        post({ type: 'error', error: err && err.message ? err.message : 'start_failed' });
      }
    }

    function stop() {
      try {
        if (recognition) {
          recognition.stop();
        }
      } catch (err) {}
    }

    function onHostMessage(event) {
      try {
        var data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (data.action === 'start') start(data.lang);
        if (data.action === 'stop') stop();
      } catch (err) {}
    }

    document.addEventListener('message', onHostMessage);
    window.addEventListener('message', onHostMessage);
    post({ type: 'ready' });
  </script>
</body>
</html>
`;

type VoiceStatus =
  | 'idle'
  | 'listening'
  | 'processing'
  | 'result'
  | 'error';

export const VoiceInputModal = ({ route, navigation }: any) => {
  const { cartId } = route.params;
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const styles = React.useMemo(() => getStyles(theme), [theme]);
  const webViewRef = useRef<WebView | null>(null);
  const [permission, requestPermission] = useMicrophonePermissions();
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [recognizedText, setRecognizedText] = useState('');
  const [parsedItem, setParsedItem] = useState<ParsedVoiceItem | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [webViewReady, setWebViewReady] = useState(false);
  const [micScale] = useState(new Animated.Value(1));
  const waveLevels = useRef(
    Array.from({ length: 5 }, (_, index) => new Animated.Value(index % 2 ? 0.28 : 0.42))
  ).current;
  const listenTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recognizedTextRef = useRef('');
  const hasFinalResultRef = useRef(false);

  const sendToWebView = useCallback((payload: { action: string; lang?: string }) => {
    webViewRef.current?.postMessage(JSON.stringify(payload));
  }, []);

  useEffect(() => {
    if (status !== 'listening') {
      micScale.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(micScale, {
          toValue: 1.05,
          duration: 900,
          easing: Easing.ease,
          useNativeDriver: true,
        }),
        Animated.timing(micScale, {
          toValue: 1,
          duration: 900,
          easing: Easing.ease,
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [status, micScale]);

  useEffect(() => {
    if (status !== 'listening') {
      waveLevels.forEach((level) => level.setValue(0.24));
      return;
    }

    const waveAnimations = waveLevels.map((level, index) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(index * 90),
          Animated.timing(level, {
            toValue: 1,
            duration: 360,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(level, {
            toValue: 0.22,
            duration: 480,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.delay((waveLevels.length - index - 1) * 90),
        ])
      )
    );
    waveAnimations.forEach((animation) => animation.start());
    return () => waveAnimations.forEach((animation) => animation.stop());
  }, [status, waveLevels]);

  useEffect(() => {
    return () => {
      if (listenTimeoutRef.current) {
        clearTimeout(listenTimeoutRef.current);
      }
    };
  }, []);

  const applyTranscript = (text: string, isFinal: boolean) => {
    if (!text) return;
    recognizedTextRef.current = text;
    setRecognizedText(text);
    if (!isFinal) return;

    hasFinalResultRef.current = true;
    setStatus('processing');
    const parsed = parseVoiceInput(text);
    if (!parsed.name) {
      setParsedItem(null);
      setErrorMessage('Please say the product name and quantity.');
      setStatus('error');
      return;
    }
    setParsedItem(parsed);
    setErrorMessage(null);
    setStatus('result');
  };

  const startListening = async () => {
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) {
        setErrorMessage('Microphone permission is required for voice input.');
        setStatus('error');
        return;
      }
    }

    recognizedTextRef.current = '';
    hasFinalResultRef.current = false;
    setRecognizedText('');
    setParsedItem(null);
    setErrorMessage(null);
    setStatus('listening');

    if (listenTimeoutRef.current) {
      clearTimeout(listenTimeoutRef.current);
    }
    listenTimeoutRef.current = setTimeout(() => {
      sendToWebView({ action: 'stop' });
    }, 12000);

    sendToWebView({ action: 'start', lang: 'fil-PH' });
  };

  const stopListening = () => {
    sendToWebView({ action: 'stop' });
  };

  const handleUseThis = () => {
    if (!parsedItem?.name) return;
    navigation.navigate('AddEditItem', {
      cartId,
      detectedName: parsedItem.name,
      detectedQuantity: String(parsedItem.quantity),
      detectedUnit: parsedItem.unit,
      detectedCategory: parsedItem.category,
      detectedPrice: parsedItem.price != null ? String(parsedItem.price) : undefined,
      voiceInput: recognizedText,
      voiceData: parsedItem,
    });
  };

  const handleWebViewMessage = (event: WebViewMessageEvent) => {
    try {
      const payload = JSON.parse(event.nativeEvent.data) as {
        type?: string;
        text?: string;
        isFinal?: boolean;
        error?: string;
      };

      if (payload.type === 'ready') {
        setWebViewReady(true);
        return;
      }
      if (payload.type === 'unavailable') {
        setStatus('error');
        setErrorMessage(
          'Speech recognition is not available on this device. On iOS Expo Go this often requires a development build.'
        );
        return;
      }
      if (payload.type === 'started') {
        setStatus('listening');
        return;
      }
      if (payload.type === 'result' && payload.text) {
        applyTranscript(payload.text, Boolean(payload.isFinal));
        return;
      }
      if (payload.type === 'error') {
        const code = payload.error || '';
        if (code === 'no-speech' || code === 'aborted') {
          setErrorMessage("Sorry, I couldn't understand that.");
        } else if (code === 'not-allowed') {
          setErrorMessage('Microphone permission is required for voice input.');
        } else if (code === 'network') {
          setErrorMessage('Speech recognition needs an internet connection on this device. Please try again.');
        } else {
          setErrorMessage("Sorry, I couldn't understand that.");
        }
        setStatus('error');
        return;
      }
      if (payload.type === 'end') {
        if (!hasFinalResultRef.current && recognizedTextRef.current) {
          applyTranscript(recognizedTextRef.current, true);
          return;
        }
        if (!hasFinalResultRef.current && !recognizedTextRef.current) {
          setErrorMessage("Sorry, I couldn't understand that.");
          setStatus('error');
        }
      }
    } catch (error) {
      console.log('Voice WebView message error:', error);
    }
  };

  if (!permission) {
    return <View style={styles.container} />;
  }

  if (!permission.granted) {
    return (
      <View style={styles.container}>
        <View style={[styles.header, { paddingTop: insets.top + SPACING.sm }]}>
          <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()}>
            <MaterialIcons name="close" size={22} color={theme.text} />
            <Text style={styles.cancelButtonText}>Cancel</Text>
          </TouchableOpacity>
          <Text style={styles.title}>Add by Voice</Text>
          <View style={styles.headerPlaceholder} />
        </View>
        <View style={styles.permissionBox}>
          <Text style={styles.permissionText}>
            Microphone permission is required for voice input.
          </Text>
          <TouchableOpacity style={styles.primaryButton} onPress={() => void requestPermission()}>
            <Text style={styles.primaryButtonText}>Grant Permission</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondaryButton} onPress={() => navigation.goBack()}>
            <Text style={styles.secondaryButtonText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + SPACING.sm }]}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel="Back to cart"
        >
          <MaterialIcons name="close" size={22} color={theme.text} />
          <Text style={styles.cancelButtonText}>Cancel</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Add by Voice</Text>
        <View style={styles.headerPlaceholder} />
      </View>

      <ScrollView style={styles.content} contentContainerStyle={styles.contentInner}>
        <View style={styles.instructionBlock}>
          <Text style={styles.instructionEyebrow}>VOICE ENTRY</Text>
          <Text style={styles.instructionTitle}>What would you like to add?</Text>
          <Text style={styles.instructionDescription}>
            Say the product name, quantity, and an optional price.
          </Text>
          <View style={styles.exampleList}>
            <View style={styles.exampleChip}>
              <Text style={styles.exampleText}>eggs</Text>
            </View>
            <View style={styles.exampleChip}>
              <Text style={styles.exampleText}>3 chicken breast</Text>
            </View>
            <View style={styles.exampleChip}>
              <Text style={styles.exampleText}>rice 150</Text>
            </View>
          </View>
        </View>

        {recognizedText ? (
          <View style={styles.transcriptBox}>
            <Text style={styles.transcriptLabel}>
              {status === 'listening' ? 'LIVE TRANSCRIPTION' : 'YOU SAID'}
            </Text>
            <Text style={styles.transcriptText}>{recognizedText}</Text>
          </View>
        ) : null}

        {parsedItem?.name ? (
          <View style={styles.resultCard}>
            <Text style={styles.resultTitle}>Detected Product</Text>
            <Text style={styles.resultRow}>Product Name: {parsedItem.name}</Text>
            <Text style={styles.resultRow}>Quantity: {parsedItem.quantity}</Text>
            <Text style={styles.resultRow}>Unit: {parsedItem.unit}</Text>
            <Text style={styles.resultRow}>Category: {parsedItem.category}</Text>
          </View>
        ) : null}

        {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, SPACING.lg) }]}>
        <View style={styles.statusBlock}>
          <View
            style={[
              styles.statusIndicator,
              status === 'listening' && styles.statusIndicatorActive,
              status === 'error' && styles.statusIndicatorError,
            ]}
          />
          <Text
            style={[
              styles.statusTitle,
              status === 'listening' && styles.statusTitleActive,
              status === 'error' && styles.statusTitleError,
            ]}
          >
            {status === 'listening'
              ? 'Listening'
              : status === 'processing'
                ? 'Processing'
                : status === 'error'
                  ? 'Try again'
                  : parsedItem?.name
                    ? 'Item details ready'
                    : 'Ready to record'}
          </Text>
        </View>
        <Text style={styles.micText}>
          {status === 'listening'
            ? 'Speak now, then tap Stop recording'
            : status === 'processing'
              ? 'Preparing the item details'
              : status === 'error'
                ? 'Tap Start recording to try again'
                : 'Tap Start recording and say the item details'}
        </Text>
        <Animated.View style={[styles.micPulse, { transform: [{ scale: micScale }] }]}>
          <View
            style={[
              styles.micHalo,
              status === 'listening' && styles.micHaloActive,
            ]}
          />
          <TouchableOpacity
            style={[styles.micButton, status === 'listening' && styles.micButtonActive]}
            onPress={() => {
              if (status === 'listening') stopListening();
              else void startListening();
            }}
            disabled={!webViewReady || status === 'processing'}
            accessibilityRole="button"
            accessibilityLabel={status === 'listening' ? 'Stop voice input' : 'Start voice input'}
          >
            <MaterialIcons
              name={status === 'listening' ? 'mic-off' : 'mic'}
              size={30}
              color={theme.isDark ? '#111827' : '#FFFFFF'}
            />
          </TouchableOpacity>
        </Animated.View>
        <View style={styles.waveform} accessibilityLabel={status === 'listening' ? 'Listening' : undefined}>
          {waveLevels.map((level, index) => (
            <Animated.View
              key={index}
              style={[
                styles.waveBar,
                status === 'listening' && styles.waveBarActive,
                { transform: [{ scaleY: level }] },
              ]}
            />
          ))}
        </View>
        <Text style={styles.recordButtonLabel}>
          {status === 'listening' ? 'Stop recording' : 'Start recording'}
        </Text>
        <TouchableOpacity
          style={[styles.confirmButton, !parsedItem?.name && styles.confirmButtonDisabled]}
          onPress={handleUseThis}
          disabled={!parsedItem?.name}
          accessibilityRole="button"
        >
          <Text style={styles.confirmButtonText}>Use detected item</Text>
        </TouchableOpacity>
      </View>

      <WebView
        ref={webViewRef}
        source={{ html: SPEECH_HTML }}
        originWhitelist={['*']}
        style={styles.hiddenWebView}
        javaScriptEnabled
        mediaPlaybackRequiresUserAction={false}
        mediaCapturePermissionGrantType="grant"
        onMessage={handleWebViewMessage}
        onError={(event) => {
          console.log('Voice WebView error:', event.nativeEvent);
        }}
      />
    </View>
  );
};

const getStyles = (theme: ReturnType<typeof useTheme>) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: SPACING.md,
    paddingHorizontal: SPACING.lg,
    backgroundColor: theme.surface,
    gap: SPACING.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  backButton: {
    minWidth: 78,
    height: 40,
    paddingHorizontal: SPACING.sm,
    borderRadius: 12,
    backgroundColor: theme.inputBackground,
    justifyContent: 'center',
    alignItems: 'center',
    flexDirection: 'row',
    gap: 2,
  },
  cancelButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: theme.textSecondary,
  },
  headerPlaceholder: {
    width: 78,
  },
  title: {
    flex: 1,
    textAlign: 'center',
    fontSize: 17,
    fontWeight: '700',
    color: theme.text,
  },
  placeholder: {
    width: 24,
  },
  content: {
    flex: 1,
  },
  contentInner: {
    flexGrow: 1,
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.xl,
    paddingBottom: SPACING.xl,
    justifyContent: 'flex-start',
  },
  instructionBlock: {
    alignItems: 'flex-start',
    padding: SPACING.lg,
    backgroundColor: theme.card,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: theme.border,
    shadowColor: theme.shadow,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: theme.isDark ? 0.12 : 0.05,
    shadowRadius: 10,
    elevation: 2,
  },
  instructionEyebrow: {
    color: theme.primary,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
  },
  instructionTitle: {
    fontSize: 21,
    fontWeight: '700',
    color: theme.text,
    lineHeight: 28,
    marginTop: SPACING.sm,
  },
  instructionDescription: {
    color: theme.textSecondary,
    fontSize: 14,
    lineHeight: 21,
    marginTop: SPACING.xs,
  },
  exampleList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
    marginTop: SPACING.md,
  },
  exampleChip: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: 16,
    backgroundColor: theme.inputBackground,
    borderWidth: 1,
    borderColor: theme.border,
  },
  exampleText: {
    fontSize: 13,
    fontWeight: '500',
    color: theme.textSecondary,
  },
  micContainer: {
    alignItems: 'center',
    marginVertical: SPACING.xl,
  },
  micPulse: {
    width: 110,
    height: 110,
    alignItems: 'center',
    justifyContent: 'center',
  },
  micHalo: {
    position: 'absolute',
    width: 104,
    height: 104,
    borderRadius: 52,
    borderWidth: 1,
    borderColor: `${theme.primary}40`,
  },
  micHaloActive: {
    borderColor: `${theme.danger}55`,
  },
  micButton: {
    width: 78,
    height: 78,
    borderRadius: 39,
    backgroundColor: theme.primary,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: theme.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: theme.isDark ? 0.12 : 0.2,
    shadowRadius: 8,
    elevation: 4,
  },
  micButtonActive: {
    backgroundColor: theme.danger,
  },
  micIcon: {
    fontSize: 48,
  },
  micText: {
    fontSize: 12,
    lineHeight: 18,
    color: theme.textSecondary,
    textAlign: 'center',
  },
  statusBlock: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
  },
  statusIndicator: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.textMuted,
  },
  statusIndicatorActive: {
    backgroundColor: theme.primary,
  },
  statusIndicatorError: {
    backgroundColor: theme.danger,
  },
  statusTitle: {
    color: theme.textSecondary,
    fontSize: 13,
    fontWeight: '700',
  },
  statusTitleActive: {
    color: theme.primary,
  },
  statusTitleError: {
    color: theme.danger,
  },
  waveform: {
    height: 22,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  waveBar: {
    width: 4,
    height: 20,
    borderRadius: 2,
    backgroundColor: theme.textMuted,
  },
  waveBarActive: {
    backgroundColor: theme.primary,
  },
  recordButtonLabel: {
    color: theme.text,
    fontSize: 13,
    fontWeight: '600',
    marginBottom: SPACING.xs,
  },
  stopButton: {
    marginTop: SPACING.md,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    borderRadius: 20,
    backgroundColor: COLORS.danger,
  },
  stopButtonText: {
    color: COLORS.white,
    fontWeight: '700',
  },
  transcriptBox: {
    padding: SPACING.md,
    backgroundColor: theme.surface,
    borderRadius: 16,
    marginBottom: SPACING.lg,
    borderWidth: 1,
    borderColor: theme.border,
  },
  transcriptLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
    color: theme.primary,
    marginBottom: SPACING.xs,
  },
  transcriptText: {
    fontSize: 16,
    lineHeight: 24,
    color: theme.text,
    fontWeight: '500',
  },
  resultCard: {
    backgroundColor: theme.card,
    borderRadius: 16,
    padding: SPACING.md,
    marginBottom: SPACING.lg,
    gap: 6,
    borderWidth: 1,
    borderColor: theme.border,
  },
  resultTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: theme.primary,
    marginBottom: 4,
  },
  resultRow: {
    fontSize: 14,
    color: theme.text,
    fontWeight: '600',
  },
  errorText: {
    color: COLORS.danger,
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: SPACING.md,
  },
  instructionsBox: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.lg,
    backgroundColor: `${theme.primary}10`,
    borderRadius: 12,
    borderLeftWidth: 4,
    borderLeftColor: theme.primary,
  },
  instructionsTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: theme.primary,
    marginBottom: SPACING.xs,
  },
  instructionsText: {
    fontSize: 13,
    color: theme.text,
    lineHeight: 20,
  },
  permissionBox: {
    flex: 1,
    justifyContent: 'center',
    padding: SPACING.xl,
    gap: SPACING.md,
  },
  permissionText: {
    fontSize: 16,
    textAlign: 'center',
    color: theme.text,
    marginBottom: SPACING.md,
  },
  primaryButton: {
    backgroundColor: theme.primary,
    borderRadius: 12,
    paddingVertical: SPACING.md,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: theme.headerText,
    fontWeight: '700',
  },
  secondaryButton: {
    alignItems: 'center',
    paddingVertical: SPACING.md,
  },
  secondaryButtonText: {
    color: theme.text,
    fontWeight: '600',
  },
  footer: {
    alignItems: 'center',
    gap: SPACING.xs,
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.lg,
    paddingBottom: SPACING.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
    backgroundColor: theme.surface,
    shadowColor: theme.shadow,
    shadowOffset: { width: 0, height: -3 },
    shadowOpacity: theme.isDark ? 0 : 0.04,
    shadowRadius: 8,
    elevation: 4,
  },
  cancelButton: {
    flex: 1,
    paddingVertical: SPACING.md,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  cancelButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: theme.text,
  },
  secondaryFooterButton: {
    flex: 1,
    paddingVertical: SPACING.md,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.primary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  secondaryFooterButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: theme.primary,
  },
  confirmButton: {
    width: '100%',
    minHeight: 52,
    flex: 0,
    borderRadius: 14,
    backgroundColor: theme.primary,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: SPACING.sm,
    shadowColor: theme.primary,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: theme.isDark ? 0 : 0.16,
    shadowRadius: 6,
    elevation: 2,
  },
  confirmButtonDisabled: {
    opacity: 0.5,
  },
  confirmButtonText: {
    fontSize: 15,
    fontWeight: '700',
    color: theme.isDark ? '#111827' : theme.headerText,
  },
  hiddenWebView: {
    width: 1,
    height: 1,
    opacity: 0.01,
    position: 'absolute',
  },
});
