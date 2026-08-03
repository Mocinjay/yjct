package com.clipstitcher

import android.graphics.Bitmap
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.media.MediaMuxer
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.util.concurrent.Executors

/**
 * Losslessly concatenates MP4 segments (all recorded with identical encoder
 * settings) by remuxing samples into one file, then writes a poster-frame
 * JPEG next to it.
 */
class ClipStitcherModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  private val executor = Executors.newSingleThreadExecutor()

  override fun getName() = "ClipStitcher"

  /**
   * @param trimEndSec seconds to drop off the end of the LAST segment, so a
   *   wake-word clip can end on the trigger word instead of at the segment
   *   boundary. 0 keeps every segment whole.
   */
  @ReactMethod
  fun stitch(
    segmentPaths: ReadableArray,
    outputPath: String,
    trimEndSec: Double,
    promise: Promise,
  ) {
    executor.execute {
      try {
        val paths = (0 until segmentPaths.size()).map { segmentPaths.getString(it)!! }
        require(paths.isNotEmpty()) { "No segments to stitch" }

        File(outputPath).delete()
        concat(paths, outputPath, trimEndSec)
        val thumbnailPath = writeThumbnail(outputPath)
        val durationSec = readDurationSec(outputPath)

        val result = Arguments.createMap().apply {
          putString("outputPath", outputPath)
          putString("thumbnailPath", thumbnailPath)
          putDouble("durationSec", durationSec)
        }
        promise.resolve(result)
      } catch (e: Exception) {
        promise.reject("stitch", e.message, e)
      }
    }
  }

  private fun concat(paths: List<String>, outputPath: String, trimEndSec: Double) {
    val muxer = MediaMuxer(outputPath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
    var videoTrack = -1
    var audioTrack = -1

    // Track layout comes from the first segment; all segments share encoder settings.
    run {
      val probe = MediaExtractor()
      probe.setDataSource(paths[0])
      for (i in 0 until probe.trackCount) {
        val format = probe.getTrackFormat(i)
        val mime = format.getString(MediaFormat.KEY_MIME) ?: continue
        if (mime.startsWith("video/") && videoTrack < 0) {
          videoTrack = muxer.addTrack(format)
        } else if (mime.startsWith("audio/") && audioTrack < 0) {
          audioTrack = muxer.addTrack(format)
        }
      }
      probe.release()
    }
    require(videoTrack >= 0) { "First segment has no video track" }
    muxer.start()

    val buffer = ByteBuffer.allocate(2 * 1024 * 1024)
    val info = android.media.MediaCodec.BufferInfo()
    var offsetUs = 0L

    for ((pathIndex, path) in paths.withIndex()) {
      val extractor = MediaExtractor()
      extractor.setDataSource(path)
      var segmentEndUs = 0L

      // Samples past this are dropped. A trim that would swallow the whole
      // segment is a bug upstream, not an instruction to emit nothing, so it
      // is ignored rather than acted on.
      val cutoffUs = if (pathIndex == paths.lastIndex && trimEndSec > 0) {
        val durationUs = (0 until extractor.trackCount)
          .map { extractor.getTrackFormat(it) }
          .filter { it.containsKey(MediaFormat.KEY_DURATION) }
          .maxOfOrNull { it.getLong(MediaFormat.KEY_DURATION) } ?: 0L
        val cutoff = durationUs - (trimEndSec * 1_000_000).toLong()
        if (cutoff > 0) cutoff else Long.MAX_VALUE
      } else {
        Long.MAX_VALUE
      }

      for (i in 0 until extractor.trackCount) {
        val format = extractor.getTrackFormat(i)
        val mime = format.getString(MediaFormat.KEY_MIME) ?: continue
        val dstTrack = when {
          mime.startsWith("video/") -> videoTrack
          mime.startsWith("audio/") && audioTrack >= 0 -> audioTrack
          else -> continue
        }

        extractor.selectTrack(i)
        while (true) {
          info.size = extractor.readSampleData(buffer, 0)
          if (info.size < 0 || extractor.sampleTime > cutoffUs) {
            break
          }
          info.presentationTimeUs = extractor.sampleTime + offsetUs
          info.offset = 0
          info.flags = extractorFlagsToCodecFlags(extractor.sampleFlags)
          muxer.writeSampleData(dstTrack, buffer, info)
          segmentEndUs = maxOf(segmentEndUs, extractor.sampleTime)
          extractor.advance()
        }
        extractor.unselectTrack(i)

        if (format.containsKey(MediaFormat.KEY_DURATION)) {
          val declared = minOf(format.getLong(MediaFormat.KEY_DURATION), cutoffUs)
          segmentEndUs = maxOf(segmentEndUs, declared)
        }
      }

      extractor.release()
      offsetUs += segmentEndUs
    }

    muxer.stop()
    muxer.release()
  }

  private fun extractorFlagsToCodecFlags(sampleFlags: Int): Int {
    var flags = 0
    if (sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC != 0) {
      flags = flags or android.media.MediaCodec.BUFFER_FLAG_KEY_FRAME
    }
    return flags
  }

  private fun writeThumbnail(clipPath: String): String {
    val thumbnailPath = clipPath.removeSuffix(".mp4") + ".jpg"
    val retriever = MediaMetadataRetriever()
    try {
      retriever.setDataSource(clipPath)
      val frame = retriever.getFrameAtTime(0) ?: return thumbnailPath
      val scale = 640f / maxOf(frame.width, frame.height)
      val scaled = if (scale < 1f) {
        Bitmap.createScaledBitmap(
          frame,
          (frame.width * scale).toInt(),
          (frame.height * scale).toInt(),
          true,
        )
      } else {
        frame
      }
      FileOutputStream(thumbnailPath).use { out ->
        scaled.compress(Bitmap.CompressFormat.JPEG, 80, out)
      }
    } finally {
      retriever.release()
    }
    return thumbnailPath
  }

  private fun readDurationSec(clipPath: String): Double {
    val retriever = MediaMetadataRetriever()
    return try {
      retriever.setDataSource(clipPath)
      val ms = retriever
        .extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
        ?.toLongOrNull() ?: 0L
      ms / 1000.0
    } finally {
      retriever.release()
    }
  }
}
