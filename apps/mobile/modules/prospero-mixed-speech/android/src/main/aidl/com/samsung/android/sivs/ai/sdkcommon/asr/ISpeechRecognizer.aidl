package com.samsung.android.sivs.ai.sdkcommon.asr;

import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import com.samsung.android.sivs.ai.sdkcommon.asr.IRecognitionListener;

interface ISpeechRecognizer {
  boolean prepare(in Bundle configuration);
  boolean write(in ParcelFileDescriptor audio, IRecognitionListener listener);
  oneway void cancel();
  boolean release();
}
