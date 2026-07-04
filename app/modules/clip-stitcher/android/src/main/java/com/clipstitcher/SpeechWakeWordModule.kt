package com.clipstitcher

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * Keyless wake-phrase detection via Android's built-in SpeechRecognizer.
 *
 * Mic-based: emits "SpeechWakeWordTranscript" events with partial/final
 * transcripts; JS matches the wake phrase. Auto-restarts after each result
 * or error to stay listening. No vendor, no API key.
 *
 * Known platform caveat: the recognizer runs in the system's speech service
 * (separate process), so concurrent capture with the camera's MediaRecorder
 * is subject to Android's shared-mic rules; on some devices one side gets
 * silence. The mock trigger and manual Clip-now button remain fallbacks.
 */
class SpeechWakeWordModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  private val mainHandler = Handler(Looper.getMainLooper())
  private var recognizer: SpeechRecognizer? = null
  private var listening = false

  override fun getName() = "SpeechWakeWord"

  @ReactMethod
  fun requestPermission(promise: Promise) {
    // RECORD_AUDIO is requested by the capture flow already; recognition
    // availability is the only additional gate on Android.
    promise.resolve(SpeechRecognizer.isRecognitionAvailable(ctx))
  }

  @ReactMethod
  fun startListening(promise: Promise) {
    mainHandler.post {
      if (!SpeechRecognizer.isRecognitionAvailable(ctx)) {
        promise.reject("speech_unavailable", "Speech recognition is not available on this device.")
        return@post
      }
      listening = true
      startRecognizerLocked()
      promise.resolve(true)
    }
  }

  @ReactMethod
  fun stopListening(promise: Promise) {
    mainHandler.post {
      listening = false
      recognizer?.destroy()
      recognizer = null
      promise.resolve(true)
    }
  }

  // Required no-ops so NativeEventEmitter does not warn.
  @ReactMethod
  fun addListener(@Suppress("UNUSED_PARAMETER") eventName: String) {}

  @ReactMethod
  fun removeListeners(@Suppress("UNUSED_PARAMETER") count: Double) {}

  private fun startRecognizerLocked() {
    recognizer?.destroy()
    val r = SpeechRecognizer.createSpeechRecognizer(ctx)
    recognizer = r
    r.setRecognitionListener(object : RecognitionListener {
      override fun onPartialResults(partialResults: Bundle?) {
        emitTranscripts(partialResults)
      }

      override fun onResults(results: Bundle?) {
        emitTranscripts(results)
        restartSoon(150)
      }

      override fun onError(error: Int) {
        // BUSY/insufficient errors need a longer back-off than no-match.
        val delay =
          if (error == SpeechRecognizer.ERROR_NO_MATCH ||
            error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT
          ) 250L else 1500L
        restartSoon(delay)
      }

      override fun onReadyForSpeech(params: Bundle?) {}
      override fun onBeginningOfSpeech() {}
      override fun onRmsChanged(rmsdB: Float) {}
      override fun onBufferReceived(buffer: ByteArray?) {}
      override fun onEndOfSpeech() {}
      override fun onEvent(eventType: Int, params: Bundle?) {}
    })
    val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
      putExtra(
        RecognizerIntent.EXTRA_LANGUAGE_MODEL,
        RecognizerIntent.LANGUAGE_MODEL_FREE_FORM,
      )
      putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
      putExtra(RecognizerIntent.EXTRA_LANGUAGE, "en-US")
    }
    r.startListening(intent)
  }

  private fun restartSoon(delayMs: Long) {
    mainHandler.postDelayed({
      if (listening) {
        startRecognizerLocked()
      }
    }, delayMs)
  }

  private fun emitTranscripts(bundle: Bundle?) {
    val texts = bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION) ?: return
    val best = texts.firstOrNull() ?: return
    if (best.isBlank()) return
    ctx
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("SpeechWakeWordTranscript", best)
  }
}
