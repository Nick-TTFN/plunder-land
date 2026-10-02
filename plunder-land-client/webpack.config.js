const HTMLWebpackPlugin = require('html-webpack-plugin')
const CopyWebpackPlugin = require('copy-webpack-plugin')
const { BundleAnalyzerPlugin } = require('webpack-bundle-analyzer')
const { DefinePlugin } = require('webpack')

module.exports = (env, options) => {
  // The game server's address (src/config.ts). Required for a production build,
  // so a deploy can never ship without one; a development build defaults to a
  // local server.
  const serverUrl = process.env.SERVER_URL ||
    (options.mode === 'production' ? undefined : 'http://localhost:8000')
  if (serverUrl === undefined) throw new Error('SERVER_URL must be set for a production build')

  return {
    devtool: options.mode === 'production' ? 'source-map' : 'inline-source-map',
    devServer: {
      static: 'dist',
      port: 3000
    },
    output: {
      filename: '[name].[contenthash].js',
      clean: true
    },
    performance: {
      hints: false
    },
    plugins: [
      new DefinePlugin({ __SERVER_URL__: JSON.stringify(serverUrl) }),
      // dist/report.html only when asked for (ANALYZE=1 npm run build): built
      // every time, it was published with the site.
      ...(process.env.ANALYZE === '1' ? [new BundleAnalyzerPlugin({ analyzerMode: 'static', openAnalyzer: false })] : []),
      new CopyWebpackPlugin({
        patterns: [
          {
            from: 'assets/res',
            to: 'res'
          }
        ]
      }),
      new HTMLWebpackPlugin({
        template: 'assets/index.html',
        filename: 'index.html'
      })
    ],
    resolve: {
      extensions: ['.ts', '.js']
    },
    module: {
      rules: [{
        test: /\.(js|ts)$/,
        exclude: /node_modules/,
        loader: 'babel-loader'
      }]
    }
  }
}
