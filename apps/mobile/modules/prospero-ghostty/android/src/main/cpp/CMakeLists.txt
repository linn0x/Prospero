cmake_minimum_required(VERSION 3.22.1)
project(prospero_ghostty)

add_library(ghostty SHARED IMPORTED)
set_target_properties(ghostty PROPERTIES IMPORTED_LOCATION "${CMAKE_CURRENT_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libghostty.so")

add_library(prospero_ghostty SHARED prospero_ghostty.cpp)
target_include_directories(prospero_ghostty PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/include")
target_link_libraries(prospero_ghostty ghostty android EGL GLESv3 jnigraphics log)
