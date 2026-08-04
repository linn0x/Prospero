// app.json 是权威配置;这里只做构建期覆盖。
//
// bundle id 会随签名证书而变(不同证书绑定不同的 App ID),那是构建环境的属性,
// 不是项目的属性,所以不写进 app.json。
// 用法:IOS_BUNDLE_ID=<你的 bundle id> npx expo prebuild -p ios --clean
module.exports = ({ config }) => ({
  ...config,
  ios: {
    ...config.ios,
    bundleIdentifier: process.env.IOS_BUNDLE_ID ?? config.ios?.bundleIdentifier,
  },
});
