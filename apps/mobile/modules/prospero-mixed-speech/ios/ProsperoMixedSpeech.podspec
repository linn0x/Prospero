Pod::Spec.new do |s|
  s.name           = 'ProsperoMixedSpeech'
  s.version        = '0.0.1'
  s.summary        = 'On-device Chinese-English speech transcription for Prospero'
  s.description    = 'Runs Chinese and English SpeechTranscriber models over one recording.'
  s.author         = 'Prospero'
  s.homepage       = 'https://localhost/prospero'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true
  s.swift_version  = '5.10'

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'AVFoundation', 'CoreMedia', 'Speech'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
