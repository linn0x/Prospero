// app.json 是权威配置;这里只做构建期覆盖。
//
// bundle id 必须在升级间保持不变，Keychain 和 App 数据容器都以它区分身份。
// 只有描述文件确实绑定了另一个 App ID 时才用环境变量显式覆盖；安装脚本会拦截
// 意外换 ID，避免一次普通升级变成全新的 App。
// 用法:IOS_BUNDLE_ID=<你的 bundle id> npx expo prebuild -p ios --clean
module.exports = ({ config }) => ({
  ...config,
  ios: {
    ...config.ios,
    bundleIdentifier: process.env.IOS_BUNDLE_ID ?? config.ios?.bundleIdentifier,
  },
});
