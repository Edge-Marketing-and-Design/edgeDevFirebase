export default function (nuxt) {
  // Register the authentication plugin using the `addPlugin` method
  this.addPlugin({
    src: '~/modules/auth/plugins/auth.js',
    ssr: false // Set to false to prevent server-side rendering errors
  })
}
