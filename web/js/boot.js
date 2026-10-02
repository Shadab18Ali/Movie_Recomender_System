// Runs synchronously in <head> (before first paint) so the static HTML shows
// the right skeleton for the requested route instead of flashing the home
// page on /film/... links. Kept tiny; everything else lives in app.js.
(function () {
  var p = location.pathname;
  var route = /^\/film\//.test(p) || /^#\/movie\//.test(location.hash) ? 'film'
    : /^\/search/.test(p) ? 'search'
      : 'home';
  var root = document.documentElement;
  root.setAttribute('data-route', route);
  root.classList.remove('no-js');
}());
