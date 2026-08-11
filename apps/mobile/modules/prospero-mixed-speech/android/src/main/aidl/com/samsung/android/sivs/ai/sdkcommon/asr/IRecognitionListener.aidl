package com.samsung.android.sivs.ai.sdkcommon.asr;

import android.os.Bundle;

interface IRecognitionListener {
  void onError(in Bundle error);
  void onResults(in Bundle results);
  void onPartialResults(in Bundle results);
}
