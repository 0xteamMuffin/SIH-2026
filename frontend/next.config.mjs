/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config) => {
    config.resolve.alias.canvas = false;
    config.resolve.alias.encoding = false;

    config.module.rules.forEach((rule) => {
      if (rule.oneOf) {
        rule.oneOf.forEach((oneOfRule) => {
          if (oneOfRule.type === 'asset/inline' && oneOfRule.generator && 'filename' in oneOfRule.generator) {
            delete oneOfRule.generator.filename;
          }
        });
      }
    });

    return config;
  },
};

export default nextConfig;
