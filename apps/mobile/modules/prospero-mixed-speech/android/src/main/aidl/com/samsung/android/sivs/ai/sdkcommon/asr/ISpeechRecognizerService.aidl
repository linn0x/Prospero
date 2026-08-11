package com.samsung.android.sivs.ai.sdkcommon.asr;

import android.os.Bundle;
import com.samsung.android.sivs.ai.sdkcommon.asr.ISpeechRecognizer;

interface ISpeechRecognizerService {
  ISpeechRecognizer create(in Bundle options);
}
