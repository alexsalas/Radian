var radian = angular.module('radian', []);

// Process attributes for plot directives.  All attributes, except for
// a small number of special cases (ID, CLASS, NG-*) are added as
// Angular scope variables, along with some extra information about
// the free variables and the original expression for the attribute.
// Changes to the attribute value are processed by re-evaluation using
// $observe and changes to free variables in the Radian expression are
// processed using a (slightly complicated) setup of scope.$watch
// listeners.

//===> THERE MIGHT BE ONE NASTY THING HERE.  WE MIGHT NEED TO
//     TRANSLATE "{{expr}}" INTO "scope.$eval(expr)" IN radianEval.
//     I'M MEDIUM CONVINCED THAT THIS SHOULDN'T BE A PROBLEM.  HERE'S
//     THE POSSIBLE CHAIN OF EVENTS CASING TROUBLE: YOU SET UP AN
//     ATTRIBUTE WITH AN EXPRESSION CONTAINING BOTH A FREE VARIABLE
//     AND A "{{expr}}" THING.  ANGULAR SHOULD IMMEDIATELY INTERPOLATE
//     THE "{{expr}}" SO THAT WE NEVER SEE IT, IN WHICH CASE CHANGES
//     TO THE "expr" SHOULD BE DEALT WITH BY A $observe.  CHANGES TO
//     THE FREE VARIABLE (WHICH WILL REQUIRE A RE-EVALUATION OF THE
//     EXPRESSION) SHOULD GO OFF O.K., SINCE THE STORED EXPRESSION HAS
//     ALREADY HAD ITS "{{expr}}" BITS INTERPOLATED BY ANGULAR.
//     THERE, I CONVINCED MYSELF IT WOULD ALL BE ALL RIGHT...

radian.factory('processAttrs', ['radianEval', function(radianEval) {
  'use strict';

  return function(scope, as) {
    scope.$$radianVars = { };
    Object.keys(as).forEach(function(a) {
      // Skip the specials.
      if (a == "id" || a == "class" || a.charAt(0) == "$" ||
          a.search(/^ng[A-Z]/) != -1) return;

      // Passing the true flag to radianEval gets us the free
      // variables in the expression as well as the current expression
      // value.
      var val = radianEval(scope, as[a], true, true);

      // Record the original expression and its free variables and set
      // the value of the scope variable.
      scope.$$radianVars[a] = { fvs: val[1], expr: as[a] };
      scope[a] = val[0];

      // Set up watchers for each of the free variables in the
      // expression.  When these watchers are triggered, they just
      // re-evaluate the expression for the attribute using its
      // original textual form.  We keep track of the return values
      // from the calls to scope.$watch so that we can cancel these
      // watches later if the free variables change.
      var entry = scope.$$radianVars[a];
      entry.fvwatchers = { };
      entry.fvs.forEach(function(v) {
        entry.fvwatchers[v] = scope.$watch(v, function() {
          scope[a] = radianEval(scope, entry.expr);
        }, true);
      });

      // Observe the value of the attribute: if the value (i.e. the
      // expression) changes, we pull in the new expression,
      // re-evaluate and rearrange the free variable watchers.
      as.$observe(a, function(v) {
        entry.expr = v;
        var val = radianEval(scope, v, true);
        scope[a] = val[0];
        entry.fvs = val[1];
        Object.keys(entry.fvwatchers).forEach(function(v) {
          // The new free variables are already in entry.fvs.  If this
          // one isn't in there, deregister the watch and remove it.
          if (entry.fvs.indexOf(v) == -1) {
            entry.fvwatchers[v]();
            delete entry.fvwatchers[v];
          }
        });
        // Add watchers for any new free variables.
        entry.fvs.forEach(function(v) {
          if (!entry.fvwatchers[v])
            entry.fvwatchers[v] = scope.$watch(v, function() {
              scope[a] = radianEval(scope, entry.expr);
            }, true);
        });
      });
    });
  };
}]);


// Main plot directive.  Kind of complicated...

radian.directive('plot',
 ['processAttrs', '$timeout', '$rootScope', 'dumpScope', 'dft', 'radianLegend',
 function(processAttrs, $timeout, $rootScope, dumpScope, dft, radianLegend)
{
  'use strict';

  // We do setup work here so that we can organise things before the
  // transcluded plotting directives are linked.
  function preLink(scope, elm, as, transclude) {
    // Process attributes, bringing all but a few special cases into
    // Angular scope as regular variables (to be use in data access
    // expressions).
    processAttrs(scope, as);

    // Deal with plot dimension attributes: explicit attribute values
    // override CSS values.  Do sensible things with width, height and
    // aspect ratio...
    var h = 300, asp = 1.618, w = asp * h;
    var aw = as.width, ah = as.height, aasp = as.aspect;
    var cw = elm.width(), ch = elm.height();
    var casp = elm.css('aspect') ? parseFloat(elm.css('aspect')) : null;
    if (aw && ah && aasp || ah && aw) { h = ah; w = aw; asp = w / h; }
    else if (ah && aasp) { h = ah; asp = aasp; w = h * asp; }
    else if (aw && aasp) { w = aw; asp = aasp; h = w / asp; }
    else if (ah) {
      h = ah;
      if (cw) { w = cw; asp = w / h; }
      else if (casp) { asp = casp; w = h * asp; }
      else { w = h * asp; }
    } else if (aw) {
      w = aw;
      if (ch) { h = ch; asp = w / h; }
      else if (casp) { asp = casp; h = w / asp; }
      else { h = w / asp; }
    } else if (aasp) {
      asp = aasp;
      if (cw) { w = cw; h = w / asp; }
      else if (ch) { h = ch; w = h * asp; }
      else { w = h * asp; }
    } else if (ch && cw) { h = ch; w = cw; asp = w / h; }
    else if (ch && casp) { h = ch; asp = casp; w = h * asp; }
    else if (cw && casp) { w = cw; asp = casp; h = w / asp; }
    else if (ch) { h = ch; w = h * asp; }
    else if (cw) { w = cw; h = w / asp; }
    else if (casp) { asp = casp; h = w / asp; }
    scope.width = w; scope.height = h;
    scope.svg = elm.children()[1];
    $(elm).css('width', w).css('height', h);

    // Set up view list and function for child elements to add plots.
    scope.views = [];
    scope.switchable = [];
    scope.addPlot = function(s) {
      if (scope.hasOwnProperty('legendSwitches')) scope.switchable.push(s);
      s.enabled = true;
    };

    transclude(scope.$new(), function (cl) { elm.append(cl); });
  };

  // We do the actual plotting after the transcluded plot type
  // elements are linked.
  function postLink(scope, elm) {
    function redraw() {
      scope.views.forEach(function(v) { draw(v, scope); });
    };
    function reset() {
      scope.$broadcast('setupExtra');
      scope.views = svgs.map(function(s, i) {
        return setup(scope, s, i, svgs.length);
      });
      if (setupBrush) setupBrush();
      redraw();
    };

    // Set up plot areas (including zoomers).
    var svgelm = d3.select(scope.svg);
    if (scope.uivisible)
      scope.height -= parseInt($(elm.children()[0]).css('height'));
    svgelm.attr('width', scope.width).attr('height', scope.height);
    var mainsvg = svgelm.append('g')
      .attr('width', scope.width).attr('height', scope.height);
    var svgs = [mainsvg];
    var setupBrush = null;
    if (scope.hasOwnProperty('zoomX')) {
      var zfrac = scope.zoomFraction || 0.2;
      zfrac = Math.min(0.95, Math.max(0.05, zfrac));
      var zoomHeight = (scope.height - 6) * zfrac;
      var mainHeight = (scope.height - 6) * (1 - zfrac);
      var zoomsvg = svgelm.append('g')
        .attr('transform', 'translate(0,' + (mainHeight + 6) + ')')
        .attr('width', scope.width).attr('height', zoomHeight);
      svgs.push(zoomsvg);
      svgs[0].attr('height', mainHeight);

      setupBrush = function() {
        svgelm.append('defs').append('clipPath')
          .attr('id', 'xzoomclip')
          .append('rect')
          .attr('width', scope.views[0].realwidth)
          .attr('height', scope.views[0].realheight);
        scope.views[0].clip = 'xzoomclip';
        var brush = d3.svg.brush().x(scope.views[1].x);
        brush.on('brush', function() {
          scope.views[0].x.domain(brush.empty() ?
                                  scope.views[1].x.domain() : brush.extent());
          draw(scope.views[0], scope);
        });
        scope.views[1].post = function(svg) {
          svg.append('g')
            .attr('class', 'x brush')
            .call(brush)
            .selectAll('rect')
            .attr('y', -6)
            .attr('height', scope.views[1].realheight + 7);
        }
      };
    }

    $timeout(function() {
      // Draw plots and legend.
      reset();
      radianLegend(svgelm, scope);

      // Register plot data change handlers.
      scope.$on('paintChange', redraw);
      scope.$on('dataChange', reset);

      // Register UI event handlers.
      scope.$watch('strokesel', redraw);
      scope.$watch('xidx', reset);
      scope.$watch('yidx', reset);
    }, 0);

    // Set up interactivity.
    // ===> TODO: zoom and pan
    // ===> TODO: "layer" visibility
    // ===> TODO: styling changes
  };


  function processRanges(scope, rangea, rangexa, rangeya,
                         fixedxrv, xextv, xrngv,
                         fixedyrv, yextv, yrngv) {
    if (scope.hasOwnProperty(rangea) ||
        scope.hasOwnProperty(rangexa) || scope.hasOwnProperty(rangeya)) {
      var xrange, yrange;
      if (scope.hasOwnProperty(rangea)) {
        var ranges = scope[rangea].split(";");
        if (ranges.length == 2) {
          xrange = ranges[0];
          yrange = ranges[1];
        }
      }
      if (scope.hasOwnProperty(rangexa)) xrange = scope[rangexa];
      if (scope.hasOwnProperty(rangeya)) yrange = scope[rangeya];
      if (xrange) {
        var xs = xrange.split(","), vals = xs.map(parseFloat);
        var ok = false, ext = null;
        if (xs.length == 2 && xs[0] && xs[1]) {
          // "min,max"
          if (!isNaN(vals[0]) && !isNaN(vals[1])) {
            ok = true; ext = [vals[0], vals[1]];
            scope[fixedxrv] = true;
            scope[xextv] = ext;
          }
        } else if (xs.length == 1 || xs.length == 2 && !xs[1]) {
          // "min" or "min,"
          if (!isNaN(vals[0])) { ok = true;  ext = [vals[0], null]; }
        } else if (xs.length == 2 && !xs[0]) {
          // ",max"
          if (!isNaN(vals[1])) { ok = true;  ext = [null, vals[1]]; }
        }
        if (ok) scope[xrngv] = ext;
      }
      if (yrange) {
        var ys = yrange.split(","), vals = ys.map(parseFloat);
        var ok = false, ext = null;
        if (ys.length == 2 && ys[0] && ys[1]) {
          // "min,max"
          if (!isNaN(vals[0]) && !isNaN(vals[1])) {
            ok = true; ext = [vals[0], vals[1]];
            scope[fixedyrv] = true;
            scope[yextv] = ext;
          }
        } else if (ys.length == 1 || ys.length == 2 && !ys[1]) {
          // "min" or "min,"
          if (!isNaN(vals[0])) { ok = true;  ext = [vals[0], null]; }
        } else if (ys.length == 2 && !ys[0]) {
          // ",max"
          if (!isNaN(vals[1])) { ok = true;  ext = [null, vals[1]]; }
        }
        if (ok) scope[yrngv] = ext;
      }
    }
  };

  function setup(scope, topgroup, idx, nviews) {
    var v = { svg: topgroup };

    // Determine data ranges to use for plot -- either as specified in
    // RANGE-X, RANGE-Y or RANGE (for X1 and Y1 axes) and RANGE-X2,
    // RANGE-Y2 or RANGE2 (for X2 and Y2 axes) attributes on the plot
    // element, or the union of the data ranges for all plots.
    processRanges(scope, 'range', 'rangeX', 'rangeY',
                  'fixedXRange', 'xextent', 'xrange',
                  'fixedYRange', 'yextent', 'yrange');
    processRanges(scope, 'range2', 'rangeX2', 'rangeY2',
                  'fixedX2Range', 'x2extent', 'x2range',
                  'fixedY2Range', 'y2extent', 'y2range');
    function aext(d) {
      if (d[0] instanceof Array) {
        return d3.merge(d.map(function(a) { return d3.extent(a); }));
      } else
        return d3.extent(d);
    };
    function aext2(d, d2, d2min, d2max) {
      if (d[0] instanceof Array) {
        return d3.merge(d.map(function(a) {
          return d3.extent(a.filter(function(x, i) {
            return d2[i] >= d2min && d2[i] <= d2max;
          }));
        }));
      } else
        return d3.extent(d.filter(function(x, i) {
          return d2[i] >= d2min && d2[i] <= d2max;
        }));
    };
    var xexts = [], yexts = [], hasdate = false;
    var xextend = [0, 0], yextend = [0, 0];
    var x2exts = [], y2exts = [], hasdate2 = false;
    dft(scope, function(s) {
      if (!scope.fixedXRange && s.enabled && s.x)
        xexts = xexts.concat(aext(s.x));
      if (!scope.fixedX2Range && s.enabled && s.x2)
        x2exts = x2exts.concat(aext(s.x2));
      if (!scope.fixedYRange && s.enabled && s.y) {
        if (scope.fixedXRange)
          yexts = yexts.concat(aext2(s.y, s.x,
                                     scope.xextent[0], scope.xextent[1]));
        else yexts = yexts.concat(aext(s.y));
      }
      if (!scope.fixedY2Range && s.enabled && s.y2) {
        if (scope.fixedXRange)
          y2exts = y2exts.concat(aext2(s.y2, s.x,
                                       scope.xextent[0], scope.xextent[1]));
        else y2exts = y2exts.concat(aext(s.y2));
      }
      if (s.x && s.x.metadata && s.x.metadata.format == 'date')
        hasdate = true;
      if (s.x2 && s.x2.metadata && s.x2.metadata.format == 'date')
        hasdate2 = true;
      if (s.rangeXExtend) {
        xextend[0] = Math.max(xextend[0], s.rangeXExtend[0]);
        xextend[1] = Math.max(xextend[1], s.rangeXExtend[1]);
      }
      if (s.rangeYExtend) {
        yextend[0] = Math.max(yextend[0], s.rangeYExtend[0]);
        yextend[1] = Math.max(yextend[1], s.rangeYExtend[1]);
      }
    });
    if (!scope.fixedXRange && xexts.length > 0) {
      scope.xextent = d3.extent(xexts);
      if (scope.xrange) {
        if (scope.xrange[0] != null)
          scope.xextent[0] = Math.min(scope.xextent[0], scope.xrange[0]);
        if (scope.xrange[1] != null)
          scope.xextent[1] = Math.max(scope.xextent[1], scope.xrange[1]);
      }
      if (!hasdate) {
        scope.xextent[0] -= xextend[0];
        scope.xextent[1] += xextend[1];
      }
    }
    if (!scope.fixedYRange && yexts.length > 0) {
      scope.yextent = d3.extent(yexts);
      if (scope.yrange) {
        if (scope.yrange[0] != null)
          scope.yextent[0] = Math.min(scope.yextent[0], scope.yrange[0]);
        if (scope.yrange[1] != null)
          scope.yextent[1] = Math.max(scope.yextent[1], scope.yrange[1]);
      }
      scope.yextent[0] -= yextend[0];
      scope.yextent[1] += yextend[1];
    }
    if (!scope.fixedX2Range && x2exts.length > 0) {
      scope.x2extent = d3.extent(x2exts);
      if (scope.x2range) {
        if (scope.x2range[0] != null)
          scope.x2extent[0] = Math.min(scope.x2extent[0], scope.x2range[0]);
        if (scope.x2range[1] != null)
          scope.x2extent[1] = Math.max(scope.x2extent[1], scope.x2range[1]);
      }
      // scope.x2extent[0] -= x2extend[0];
      // scope.x2extent[1] += x2extend[1];
    }
    if (!scope.fixedY2Range && y2exts.length > 0) {
      scope.y2extent = d3.extent(y2exts);
      if (scope.y2range) {
        if (scope.y2range[0] != null)
          scope.y2extent[0] = Math.min(scope.y2extent[0], scope.y2range[0]);
        if (scope.y2range[1] != null)
          scope.y2extent[1] = Math.max(scope.y2extent[1], scope.y2range[1]);
      }
      // scope.y2extent[0] -= y2extend[0];
      // scope.y2extent[1] += y2extend[1];
    }

    // Extract plot attributes.
    v.xaxis = !scope.axisX || scope.axisX != 'off';
    v.yaxis = !scope.axisY || scope.axisY != 'off';
    v.x2axis = scope.x2extent && (!scope.axisX2 || scope.axisX2 != 'off');
    v.y2axis = scope.y2extent && (!scope.axisY2 || scope.axisY2 != 'off');
    var showXAxisLabel = (nviews == 1 || nviews == 2 && idx == 1) &&
      (!scope.axisXLabel || scope.axisXLabel != 'off');
    var showYAxisLabel = !scope.axisYLabel || scope.axisYLabel != 'off';
    var showX2AxisLabel = (nviews == 1 || nviews == 2 && idx == 1) &&
      (!scope.axisX2Label || scope.axisX2Label != 'off');
    var showY2AxisLabel = !scope.axisY2Label || scope.axisY2Label != 'off';
    v.margin = { top: scope.topMargin || 2, right: scope.rightMargin || 10,
                 bottom: scope.bottomMargin || 2, left: scope.leftMargin || 2 };
    var xAxisTransform = scope.axisXTransform || "linear";
    var yAxisTransform = scope.axisYTransform || "linear";

    // Set up plot margins.
    if (v.xaxis) v.margin.bottom += 20 + (showXAxisLabel ? 15 : 0);
    if (v.yaxis) v.margin.left += 30 + (showYAxisLabel ? 22 : 0);
    if (v.x2axis) v.margin.top += 20 + (showX2AxisLabel ? 15 : 0);
    if (v.y2axis) v.margin.right += 30 + (showY2AxisLabel ? 22 : 0);
    v.realwidth = v.svg.attr('width') - v.margin.left - v.margin.right;
    v.realheight = v.svg.attr('height') - v.margin.top - v.margin.bottom;
    v.outw = v.realwidth + v.margin.left + v.margin.right;
    v.outh = v.realheight + v.margin.top + v.margin.bottom;

    // Set up D3 data ranges.
    function makeXScaler() {
      if (hasdate)
        v.x = d3.time.scale().range([0, v.realwidth]).domain(scope.xextent);
      else if (xAxisTransform == "log")
        v.x = d3.scale.log().range([0, v.realwidth])
          .domain(scope.xextent).clamp(true);
      else
        v.x = d3.scale.linear().range([0, v.realwidth])
          .domain(scope.xextent).clamp(true);
    }
    function makeX2Scaler() {
      if (hasdate2)
        v.x2 = d3.time.scale().range([0, v.realwidth]).domain(scope.x2extent);
      else if (xAxisTransform == "log")
        v.x2 = d3.scale.log().range([0, v.realwidth])
          .domain(scope.x2extent).clamp(true);
      else
        v.x2 = d3.scale.linear().range([0, v.realwidth])
          .domain(scope.x2extent).clamp(true);
    }
    function makeYScaler() {
      if (yAxisTransform == "log")
        v.y = d3.scale.log().range([v.realheight, 0])
          .domain(scope.yextent).clamp(true);
      else
        v.y = d3.scale.linear().range([v.realheight, 0])
          .domain(scope.yextent).clamp(true);
    };
    function makeY2Scaler() {
      if (yAxisTransform == "log")
        v.y2 = d3.scale.log().range([v.realheight, 0])
          .domain(scope.y2extent).clamp(true);
      else
        v.y2 = d3.scale.linear().range([v.realheight, 0])
          .domain(scope.y2extent).clamp(true);
    };
    if (scope.xextent) makeXScaler();
    if (scope.yextent) makeYScaler();
    if (scope.x2extent) makeX2Scaler();
    if (scope.y2extent) makeY2Scaler();
    if (scope.hasOwnProperty("axisXTransform"))
      scope.$watch('axisXTransform', function(n, o) {
        xAxisTransform = n || "linear";
        makeXScaler();
        if (scope.x2) makeX2Scaler();
        scope.views.forEach(function(v) { draw(v, scope); });
      });
    if (scope.hasOwnProperty("axisYTransform"))
      scope.$watch('axisYTransform', function(n, o) {
        yAxisTransform = n || "linear";
        makeYScaler();
        if (scope.y2) makeY2Scaler();
        scope.views.forEach(function(v) { draw(v, scope); });
      });

    // Figure out axis labels.
    function axisLabel(labelText, v, idxvar, selectvar, def) {
      var idx0 = null;
      if (!labelText) {
        dft(scope, function(s) {
          if (!labelText)
            if (s[v] && s[v].metadata && s[v].metadata.label) {
              labelText = s[v].metadata.label;
              if (s[v].metadata.units)
                labelText += ' (' + s[v].metadata.units + ')';
            }
          idx0 = idx0 || s[idxvar];
        });
        if (!labelText && scope[selectvar]) {
          var labs = scope[selectvar].split(',');
          labelText = labs[idx0];
        }
        if (!labelText) labelText = def;
      }
      return labelText;
    };
    if (showXAxisLabel)
      v.xlabel = axisLabel(scope.axisXLabel, 'x', 'xidx', 'selectX', 'X Axis');
    if (showYAxisLabel)
      v.ylabel = axisLabel(scope.axisYLabel, 'y', 'yidx', 'selectY', 'Y Axis');
    if (showX2AxisLabel)
      v.x2label = axisLabel(scope.axisX2Label, 'x2',
                            'xidx', 'selectX2', 'X2 Axis');
    if (showY2AxisLabel)
      v.y2label = axisLabel(scope.axisY2Label, 'y2',
                            'yidx', 'selectY2', 'Y2 Axis');

    return v;
  };

  function draw(v, scope) {
    // Clean out any pre-existing plots.
    $(v.svg[0]).empty();

    // Set up plot margins.
    var outsvg = v.svg.append('g').attr('width', v.outw).attr('height', v.outh);
    var svg = outsvg.append('g')
      .attr('transform', 'translate(' + v.margin.left + ',' +
                                        v.margin.top + ')');
    v.innersvg = svg;
    if (v.clip) svg.attr('clip-path', 'url(#' + v.clip + ')');

    // Draw D3 axes.
    if (v.xaxis && v.x) {
      var axis = d3.svg.axis()
        .scale(v.x).orient('bottom')
        .ticks(outsvg.attr('width') / 100);
      var dformat = '%Y-%m-%d';
      var has_date = false;
      dft(scope, function(s) {
        var x = s.x;
        if (x && x.metadata && x.metadata.format == 'date') {
          if (x.metadata.dateFormat) dformat = x.metadata.dateFormat;
          has_date = true;
        }
        has_date = false;
      });
      if (has_date) axis.tickFormat(d3.time.format(dformat));
      outsvg.append('g').attr('class', 'axis')
        .attr('transform', 'translate(' + v.margin.left + ',' +
              (+v.realheight + 4) + ')')
        .call(axis);
      if (v.xlabel)
        var xpos = 0, ypos = 35;
        outsvg.append('g').attr('class', 'axis-label')
        .attr('transform', 'translate(' +
              (+v.margin.left + v.realwidth / 2) +
              ',' + v.realheight + ')')
        .append('text')
        .attr('x', xpos).attr('y', ypos)
        .attr('text-anchor', 'middle').text(v.xlabel);
    }
    if (v.x2axis && v.x2) {
      var axis = d3.svg.axis()
        .scale(v.x2).orient('top')
        .ticks(outsvg.attr('width') / 100);
      var dformat = '%Y-%m-%d';
      var has_date = false;
      dft(scope, function(s) {
        var x = s.x2;
        if (x && x.metadata && x.metadata.format == 'date') {
          if (x.metadata.dateFormat) dformat = x.metadata.dateFormat;
          has_date = true;
        }
        has_date = false;
      });
      if (has_date) axis.tickFormat(d3.time.format(dformat));
      outsvg.append('g').attr('class', 'axis')
        .attr('transform', 'translate(' + v.margin.left + ',4)')
        .call(axis);
      if (v.x2label)
        var xpos = 0, ypos = 35;
        outsvg.append('g').attr('class', 'axis-label')
        .attr('transform', 'translate(' +
              (+v.margin.left + v.realwidth / 2) + ',0)')
        .append('text')
        .attr('x', xpos).attr('y', ypos)
        .attr('text-anchor', 'middle').text(v.x2label);
    }
    if (v.yaxis && v.y) {
      var axis = d3.svg.axis()
        .scale(v.y).orient('left')
        .ticks(outsvg.attr('height') / 36);
      outsvg.append('g').attr('class', 'axis')
        .attr('transform', 'translate(' + (+v.margin.left - 4) + ',0)')
        .call(axis);
      if (v.ylabel) {
        var xpos = 12, ypos = v.realheight / 2;
        outsvg.append('g').attr('class', 'axis-label')
        .append('text')
        .attr('x', xpos).attr('y', ypos)
        .attr('transform', 'rotate(-90,' + xpos + ',' + ypos + ')')
        .attr('text-anchor', 'middle').text(v.ylabel);
      }
    }
    if (v.y2axis && v.y2) {
      var axis = d3.svg.axis()
        .scale(v.y2).orient('right')
        .ticks(outsvg.attr('height') / 36);
      outsvg.append('g').attr('class', 'axis')
        .attr('transform', 'translate(' +
              (+v.realwidth + v.margin.left) + ',0)')
        .call(axis);
      if (v.y2label) {
        var xpos = v.realwidth + v.margin.left + 40, ypos = v.realheight / 2;
        outsvg.append('g').attr('class', 'axis-label')
        .append('text')
        .attr('x', xpos).attr('y', ypos)
        .attr('transform', 'rotate(-90,' + xpos + ',' + ypos + ')')
        .attr('text-anchor', 'middle').text(v.y2label);
      }
    }

    // Loop over plots, calling their draw functions one by one.
    if (v.x && v.y || v.x2 && v.y || v.x && v.y2 || v.x2 && v.y2) {
      dft(scope, function(s) {
        if (s.draw && s.enabled) {
          var xvar = false, yvar = false;
          var xscale, yscale;
          if (s.x)  { xvar = 'x';  xscale = v.x;  }
          if (s.x2) { xvar = 'x2'; xscale = v.x2; }
          if (s.y)  { yvar = 'y';  yscale = v.y;  }
          if (s.y2) { yvar = 'y2'; yscale = v.y2; }

          if (xvar && yvar) {
            // Append SVG group for this plot and draw the plot into it.
            var g = svg.append('g');
            var x = (s[xvar][0] instanceof Array) ?
              s[xvar][s.xidx ? s.xidx : 0] : s[xvar];
            var y = (s[yvar][0] instanceof Array) ?
              s[yvar][s.yidx ? s.yidx : 0] : s[yvar];
            s.draw(g, x, xscale, y, yscale, s, v.realwidth, v.realheight,
                   yvar == 'y2' ? 2 : 1);
            s.$on('$destroy', function() { g.remove(); });
          }
        }
      });
      if (v.post) v.post(v.innersvg);
    }
  };

  return {
    restrict: 'E',
    template:
    ['<div class="radian">',
       '<radian-ui></radian-ui>',
       '<svg></svg>',
     '</div>'].join(""),
    replace: true,
    transclude: true,
    scope: true,
    compile: function(elm, as, trans) {
      return { pre: function(s, e, a) { preLink(s, e, a, trans); },
               post: postLink };
    }
  };
}]);


// Link function shared by most simple plotting directives.  Does
// attribute processing, hides HTML element, sets up drawing function
// and sets up event emitters for data and paint changes.

radian.factory('plotTypeLink', ['processAttrs', function(processAttrs)
{
  var paintas = [ 'orientation', 'fill', 'fillOpacity', 'label',
                  'marker', 'markerSize', 'stroke', 'strokeOpacity',
                  'strokeWidth' ];

  return function(scope, elm, as, draw) {
    processAttrs(scope, as);
    elm.hide();
    scope.draw = draw;
    scope.$parent.addPlot(scope);

    scope.$watch('x', function() { scope.$emit('dataChange', scope); });
    scope.$watch('y', function() { scope.$emit('dataChange', scope); });
    paintas.forEach(function(a) {
      if (scope.hasOwnProperty(a))
        scope.$watch(a, function() { scope.$emit('paintChange', scope); });
    });
  };
}]);


// Simple directive just to wrap inner plotting directives that share
// options.  Brings any attributes into scope and transcludes inner
// plot directives.

radian.directive('plotOptions', ['processAttrs', function(processAttrs)
{
  'use strict';

  return {
    restrict: 'E',
    template: '<div></div>',
    replace: true,
    transclude: true,
    scope: true,
    compile: function(elm, as, trans) {
      return { pre: function(s, e, a) {
        processAttrs(s, a);
        trans(s.$new(), function (cl) { e.append(cl); });
      } };
    }
  };
}]);
// This file contains a modified version of the Acorn parser, set up
// for easy use with Angular, cut down to parse only expressions, and
// supporting some extensions to normal JavaScript expression syntax.
//
// ORIGINAL LICENSE COMMENT:
//
// Acorn is a tiny, fast JavaScript parser written in JavaScript.
//
// Acorn was written by Marijn Haverbeke and released under an MIT
// license. The Unicode regexps (for identifiers and whitespace) were
// taken from [Esprima](http://esprima.org) by Ariya Hidayat.
//
// Git repositories for Acorn are available at
//
//     http://marijnhaverbeke.nl/git/acorn
//     https://github.com/marijnh/acorn.git
//
// Please use the [github bug tracker][ghbt] to report issues.
//
// [ghbt]: https://github.com/marijnh/acorn/issues

radian.factory('radianEval',
  ['$rootScope', 'plotLib', 'radianParse',
  function($rootScope, plotLib, radianParse)
{
  // Top level JavaScript names that we don't want to treat as free
  // variables in Radian expressions.
  var excnames = ['Arguments', 'Array', 'Boolean', 'Date', 'Error', 'EvalError',
                  'Function', 'Global', 'JSON', 'Math', 'Number', 'Object',
                  'RangeError', 'ReferenceError', 'RegExp', 'String',
                  'SyntaxError', 'TypeError', 'URIError'];

  // We need to be able to call this recursively, so give it a name
  // here.
  var radianEval = function(scope, inexpr, returnfvs, skiperrors) {
    // Pass-through anything that isn't in [[ ]] brackets.
    if (typeof inexpr != "string" ||
        inexpr.substr(0,2) != '[[' && inexpr.substr(-2) != ']]')
      return returnfvs ? [inexpr, []] : inexpr;
    var expr = inexpr.substr(2, inexpr.length-4);
    if (expr == "") return returnfvs ? [0, []] : 0;

    // Parse data path as (slightly enhanced) JavaScript.
    var ast = radianParse(expr);
    estraverse.traverse(ast, { leave: function(n) {
      delete n.start; delete n.end;
    } });

    // Determine metadata key, which is only possible for simple
    // applications of member access and plucking.  (For example, for
    // an expression of the form "vic2012#tmp", the metadata key is
    // "tmp"; for the expression "vic2012#date#doy", the metadata key
    // is "doy").
    var metadatakey = null, dataset = null;
    estraverse.traverse(ast, { enter: function(node) {
      if (node.type != "PluckExpression" && node.type != "MemberExpression")
        return estraverse.VisitorOption.Skip;
      else if (node.property.type == "Identifier") {
        metadatakey = node.property.name;
        var o = node.object;
        while (o.type != "Identifier") o = o.object;
        dataset = o.name;
        return estraverse.VisitorOption.Break;
      }
    }});

    // Find free variables in JS expression for later processing.
    var exc = { }, excstack = [ ], fvs = { };
    excnames.forEach(function(n) { exc[n] = 1; });
    Object.keys(plotLib).forEach(function(k) { exc[k] = 1; });
    estraverse.traverse(ast, {
      enter: function(v, w) {
        switch (v.type) {
        case "FunctionExpression":
          // When we enter a function expression, we need to capture
          // the parameter names so that we don't record them as free
          // variables.  To deal with name shadowing, we use an
          // integer counter for names excluded from consideration as
          // free variables, rather than a simple boolean flag.
          excstack.push(v.params.map(function(p) { return p.name; }));
          v.params.forEach(function(p) {
            if (exc[p.name]) ++exc[p.name]; else exc[p.name] = 1;
          });
          break;
        case "Identifier":
          // We have a free variable, so record it.
          if (!exc[v.name]) {
            var free = true;
            if (w &&
                (w.type == "MemberExpression" || w.type == "PluckExpression") &&
                v == w.property && !w.computed) free = false;
            if (free) fvs[v.name] = 1;
          }
        }
      },
      leave: function(v) {
        if (v.type == "FunctionExpression")
          // Clear function parameters from our exclude stack as we
          // leave the function expression.
          excstack.pop().forEach(function(n) {
            if (--exc[n] == 0) delete exc[n];
          });
      }
    });

    // Vectorise arithmetic expressions.
    var astrepl = estraverse.replace(ast, {
      leave: function(n) {
        if (n.type == "BinaryExpression") {
          var fn = "";
          switch (n.operator) {
            case "+": fn = "rad$$add"; break;
            case "-": fn = "rad$$sub"; break;
            case "*": fn = "rad$$mul"; break;
            case "/": fn = "rad$$div"; break;
            case "**": fn = "rad$$pow"; break;
          }
          return !fn ? n : {
            "type":"CallExpression",
            "callee":{ "type":"Identifier","name":fn },
            "arguments": [n.left, n.right] };
        } else if (n.type == "UnaryExpression" && n.operator == "-") {
          return {
            "type":"CallExpression",
            "callee":{ "type":"Identifier","name":"rad$$neg" },
            "arguments": [n.argument] };
        } else
          return n;
      }
    });

    // Pluck expression transformations:
    //
    //  a#b     ->  a.map(function($$x) { return $$x.b; })
    //  a#b(c)  ->  a.map(function($$x) { return $$x.b(c); })
    //
    astrepl = estraverse.replace(astrepl, {
      enter: function(n) {
        if (n.type == "CallExpression" && n.callee.type == "PluckExpression") {
          return{
            type:"CallExpression",
            callee:{type:"MemberExpression", object:n.callee.object,
                    property:{type:"Identifier", name:"map"},
                    computed:false},
            arguments:
            [{type:"FunctionExpression",
              id:null, params:[{type:"Identifier", name:"$$x"}],
              body:{
                type:"BlockStatement",
                body:[{
                  type:"ReturnStatement",
                  argument:{type:"CallExpression",
                            callee:{type:"MemberExpression",
                                    object:{type:"Identifier", name:"$$x"},
                                    property:n.callee.property,
                                    computed:n.callee.property.type=="Literal"},
                            arguments:n.arguments}
                }]
              }
             }]
          };
        } else return n;
      },
      leave: function(n) {
        if (n.type == "PluckExpression") {
          return {
            type:"CallExpression",
            callee:{ type:"MemberExpression", object:n.object,
                     property:{ type:"Identifier", name:"map" },
                     computed:false },
            arguments:
            [{ type:"FunctionExpression",
               id:null, params:[{ type:"Identifier", name:"$$x"}],
               body:{
                 type:"BlockStatement",
                 body:[{ type:"ReturnStatement",
                         argument:{ type:"MemberExpression",
                                    object:{ type:"Identifier", name:"$$x" },
                                    property:n.property,
                                    computed:n.property.type=="Literal"}
                       }]
               }
             }]
          };
        }}});

    // Replace free variables in JS expression by calls to"scope.$eval".
    // We do things this way rather than using Angular's"scope.$eval" on
    // the whole JS expression because the Angular expression parser only
    // deals with a relatively small subset of JS (no anonymous functions,
    // for instance).
    astrepl = estraverse.replace(astrepl, {
      enter: function(v, w) {
        switch (v.type) {
        case "FunctionExpression":
          // When we enter a function expression, we need to capture
          // the parameter names so that we don't record them as free
          // variables.  To deal with name shadowing, we use an
          // integer counter for names excluded from consideration as
          // free variables, rather than a simple boolean flag.
          excstack.push(v.params.map(function(p) { return p.name; }));
          v.params.forEach(function(p) {
            if (exc[p.name]) ++exc[p.name]; else exc[p.name] = 1;
          });
          break;
        case "Identifier":
          if (!exc[v.name] && fvs[v.name]) {
            // We have a free variable, so replace the reference to it
            // with a call to 'scope.$eval'.
            return {
              type: "CallExpression",
              callee: { type: "MemberExpression",
                        object: { type: "Identifier", name: "scope" },
                        property: { type: "Identifier", name: "$eval" },
                        computed: false },
              arguments: [{ type: "Literal", value: v.name,
                            raw:"'" + v.name + "'" }]
            };
          }
        }
        return v;
      },
      leave: function(v) {
        if (v.type == "FunctionExpression")
          // Clear function parameters from our exclude stack as we
          // leave the function expression.
          excstack.pop().forEach(function(n) {
            if (--exc[n] == 0) delete exc[n];
          });
        return v;
      }
    });

    // Generate JS code suitable for accessing data.
    var access = escodegen.generate(astrepl);
    var ret = [];
    try {
      // Bring plot function library names into scope.
      with (plotLib) {
        eval("ret = " + access);
      }
    } catch (e) {
      if (!skiperrors)
        throw Error("radianEval failed on '" + expr + "' -- " + e.message);
    }
    if (ret && dataset && metadatakey) {
      if ($rootScope[dataset] && $rootScope[dataset].metadata &&
          $rootScope[dataset].metadata[metadatakey])
        ret.metadata = $rootScope[dataset].metadata[metadatakey];
    }
    return returnfvs ? [ret, Object.keys(fvs)] : ret;
  };

  return radianEval;
}]);


radian.factory('radianParse', function()
{
  'use strict';

  // The main exported interface (under `self.acorn` when in the
  // browser) is a `parse` function that takes a code string and
  // returns an abstract syntax tree as specified by [Mozilla parser
  // API][api], with the caveat that the SpiderMonkey-specific syntax
  // (`let`, `yield`, inline XML, etc) is not recognized.
  //
  // [api]: https://developer.mozilla.org/en-US/docs/SpiderMonkey/Parser_API

  var input, inputLen;

  var mainfn = function(inpt) {
    input = String(inpt); inputLen = input.length;
    initTokenState();
    return parseTopLevel();
  };

  // The `getLineInfo` function is mostly useful when the
  // `locations` option is off (for performance reasons) and you
  // want to find the line/column position for a given character
  // offset. `input` should be the code string that the offset refers
  // into.

  var getLineInfo = function(input, offset) {
    for (var line = 1, cur = 0;;) {
      lineBreak.lastIndex = cur;
      var match = lineBreak.exec(input);
      if (match && match.index < offset) {
        ++line;
        cur = match.index + match[0].length;
      } else break;
    }
    return {line: line, column: offset - cur};
  };

  // Acorn is organized as a tokenizer and a recursive-descent parser.
  // The `tokenize` export provides an interface to the tokenizer.
  // Because the tokenizer is optimized for being efficiently used by
  // the Acorn parser itself, this interface is somewhat crude and not
  // very modular. Performing another parse or call to `tokenize` will
  // reset the internal state, and invalidate existing tokenizers.

  function tokenize(inpt, opts) {
    input = String(inpt); inputLen = input.length;
    initTokenState();

    var t = {};
    function getToken(forceRegexp) {
      readToken(forceRegexp);
      t.start = tokStart; t.end = tokEnd;
      t.type = tokType; t.value = tokVal;
      return t;
    }
    getToken.jumpTo = function(pos, reAllowed) {
      tokPos = pos;
      var ch = input.charAt(pos - 1);
      tokRegexpAllowed = reAllowed;
      skipSpace();
    };
    return getToken;
  };

  // State is kept in (closure-)global variables. We already saw the
  // `input`, and `inputLen` variables above.

  // The current position of the tokenizer in the input.

  var tokPos;

  // The start and end offsets of the current token.

  var tokStart, tokEnd;

  // The type and value of the current token. Token types are objects,
  // named by variables against which they can be compared, and
  // holding properties that describe them (indicating, for example,
  // the precedence of an infix operator, and the original name of a
  // keyword token). The kind of value that's held in `tokVal` depends
  // on the type of the token. For literals, it is the literal value,
  // for operators, the operator name, and so on.

  var tokType, tokVal;

  // Interal state for the tokenizer. To distinguish between division
  // operators and regular expressions, it remembers whether the last
  // token was one that is allowed to be followed by an expression.
  // (If it is, a slash is probably a regexp, if it isn't it's a
  // division operator. See the `parseStatement` function for a
  // caveat.)

  var tokRegexpAllowed;

  // These store the position of the previous token, which is useful
  // when finishing a node and assigning its `end` position.

  var lastStart, lastEnd, lastEndLoc;

  // This is the parser's state. `inFunction` is used to reject
  // `return` statements outside of functions, `labels` to verify that
  // `break` and `continue` have somewhere to jump to, and `strict`
  // indicates whether strict mode is on.

  var inFunction, labels, strict;

  // This function is used to raise exceptions on parse errors. It
  // takes an offset integer (into the current `input`) to indicate
  // the location of the error, attaches the position to the end
  // of the error message, and then raises a `SyntaxError` with that
  // message.

  function raise(pos, message) {
    var loc = getLineInfo(input, pos);
    message += " (" + loc.line + ":" + loc.column + ")";
    var err = new SyntaxError(message);
    err.pos = pos; err.loc = loc; err.raisedAt = tokPos;
    throw err;
  }

  // ## Token types

  // The assignment of fine-grained, information-carrying type objects
  // allows the tokenizer to store the information it has about a
  // token in a way that is very cheap for the parser to look up.

  // All token type variables start with an underscore, to make them
  // easy to recognize.

  // These are the general types. The `type` property is only used to
  // make them recognizeable when debugging.

  var _num = {type: "num"}, _regexp = {type: "regexp"};
  var _string = {type: "string"}, _name = {type: "name"};
  var _eof = {type: "eof"};

  // Keyword tokens. The `keyword` property (also used in keyword-like
  // operators) indicates that the token originated from an
  // identifier-like word, which is used when parsing property names.
  //
  // The `beforeExpr` property is used to disambiguate between regular
  // expressions and divisions. It is set on all token types that can
  // be followed by an expression (thus, a slash after them would be a
  // regular expression).
  //
  // `isLoop` marks a keyword as starting a loop, which is important
  // to know when parsing a label, in order to allow or disallow
  // continue jumps to that label.

  var _break = {keyword: "break"}, _case = {keyword: "case", beforeExpr: true};
  var _catch = {keyword: "catch"}, _continue = {keyword: "continue"};
  var _debugger = {keyword: "debugger"}, _default = {keyword: "default"};
  var _do = {keyword: "do", isLoop: true};
  var _else = {keyword: "else", beforeExpr: true};
  var _finally = {keyword: "finally"}, _for = {keyword: "for", isLoop: true};
  var _function = {keyword: "function"}, _if = {keyword: "if"};
  var _return = {keyword: "return", beforeExpr: true};
  var _switch = {keyword: "switch"};
  var _throw = {keyword: "throw", beforeExpr: true}, _try = {keyword: "try"};
  var _var = {keyword: "var"}, _while = {keyword: "while", isLoop: true};
  var _with = {keyword: "with"}, _new = {keyword: "new", beforeExpr: true};
  var _this = {keyword: "this"};

  // The keywords that denote values.

  var _null = {keyword: "null", atomValue: null};
  var _true = {keyword: "true", atomValue: true};
  var _false = {keyword: "false", atomValue: false};

  // Some keywords are treated as regular operators. `in` sometimes
  // (when parsing `for`) needs to be tested against specifically, so
  // we assign a variable name to it for quick comparing.

  var _in = {keyword: "in", binop: 7, beforeExpr: true};

  // Map keyword names to token types.

  var keywordTypes =
    {"break": _break, "case": _case, "catch": _catch, "continue": _continue,
     "debugger": _debugger, "default": _default, "do": _do, "else": _else,
     "finally": _finally, "for": _for, "function": _function, "if": _if,
     "return": _return, "switch": _switch, "throw": _throw, "try": _try,
     "var": _var, "while": _while, "with": _with, "null": _null, "true": _true,
     "false": _false, "new": _new, "in": _in,
     "instanceof": {keyword: "instanceof", binop: 7, beforeExpr: true},
     "this": _this,
     "typeof": {keyword: "typeof", prefix: true, beforeExpr: true},
     "void": {keyword: "void", prefix: true, beforeExpr: true},
     "delete": {keyword: "delete", prefix: true, beforeExpr: true}};

  // Punctuation token types. Again, the `type` property is purely for
  // debugging.

  var _bracketL = {type: "[", beforeExpr: true}, _bracketR = {type: "]"};
  var _braceL = {type: "{", beforeExpr: true}, _braceR = {type: "}"};
  var _parenL = {type: "(", beforeExpr: true}, _parenR = {type: ")"};
  var _comma = {type: ",", beforeExpr: true};
  var _semi = {type: ";", beforeExpr: true};
  var _colon = {type: ":", beforeExpr: true};
  var _dot = {type: "."}, _question = {type: "?", beforeExpr: true};
  var _hash = {type: "#"};

  // Operators. These carry several kinds of properties to help the
  // parser use them properly (the presence of these properties is
  // what categorizes them as operators).
  //
  // `binop`, when present, specifies that this operator is a binary
  // operator, and will refer to its precedence.
  //
  // `prefix` and `postfix` mark the operator as a prefix or postfix
  // unary operator. `isUpdate` specifies that the node produced by
  // the operator should be of type UpdateExpression rather than
  // simply UnaryExpression (`++` and `--`).
  //
  // `isAssign` marks all of `=`, `+=`, `-=` etcetera, which act as
  // binary operators with a very low precedence, that should result
  // in AssignmentExpression nodes.

  var _slash = {binop: 10, beforeExpr: true};
  var _eq = {isAssign: true, beforeExpr: true};
  var _assign = {isAssign: true, beforeExpr: true};
  var _plusmin = {binop: 9, prefix: true, beforeExpr: true};
  var _incdec = {postfix: true, prefix: true, isUpdate: true};
  var _prefix = {prefix: true, beforeExpr: true};
  var _bin1 = {binop: 1, beforeExpr: true};
  var _bin2 = {binop: 2, beforeExpr: true};
  var _bin3 = {binop: 3, beforeExpr: true};
  var _bin4 = {binop: 4, beforeExpr: true};
  var _bin5 = {binop: 5, beforeExpr: true};
  var _bin6 = {binop: 6, beforeExpr: true};
  var _bin7 = {binop: 7, beforeExpr: true};
  var _bin8 = {binop: 8, beforeExpr: true};
  var _bin10 = {binop: 10, beforeExpr: true};
  var _bin11 = {binop: 11, beforeExpr: true};

  // Provide access to the token types for external users of the
  // tokenizer.

  var tokTypes =
    {bracketL: _bracketL, bracketR: _bracketR, braceL: _braceL, braceR: _braceR,
     parenL: _parenL, parenR: _parenR, comma: _comma, semi: _semi,
     colon: _colon, dot: _dot, question: _question, slash: _slash, eq: _eq,
     name: _name, eof: _eof,
     num: _num, regexp: _regexp, string: _string, hash: _hash};
  for (var kw in keywordTypes) tokTypes[kw] = keywordTypes[kw];

  // This is a trick taken from Esprima. It turns out that, on
  // non-Chrome browsers, to check whether a string is in a set, a
  // predicate containing a big ugly `switch` statement is faster than
  // a regular expression, and on Chrome the two are about on par.
  // This function uses `eval` (non-lexical) to produce such a
  // predicate from a space-separated string of words.
  //
  // It starts by sorting the words by length.

  function makePredicate(words) {
    words = words.split(" ");
    var f = "", cats = [], skip;
//    out: for (var i = 0; i < words.length; ++i) {
    for (var i = 0; i < words.length; ++i) {
      skip = false;
      for (var j = 0; j < cats.length; ++j)
        if (cats[j][0].length == words[i].length) {
          cats[j].push(words[i]);
          skip = true;
          break;
//          continue out;
        }
      if (!skip) cats.push([words[i]]);
      skip = false;
    }
    function compareTo(arr) {
      if (arr.length == 1)
        return f += "return str === " + JSON.stringify(arr[0]) + ";";
      f += "switch(str){";
      for (var i = 0; i < arr.length; ++i)
        f += "case " + JSON.stringify(arr[i]) + ":";
      f += "return true}return false;";
    }

    // When there are more than three length categories, an outer
    // switch first dispatches on the lengths, to save on comparisons.

    if (cats.length > 3) {
      cats.sort(function(a, b) {return b.length - a.length;});
      f += "switch(str.length){";
      for (var i = 0; i < cats.length; ++i) {
        var cat = cats[i];
        f += "case " + cat[0].length + ":";
        compareTo(cat);
      }
      f += "}";

    // Otherwise, simply generate a flat `switch` statement.

    } else {
      compareTo(words);
    }
    return new Function("str", f);
  }

  // ECMAScript 5 reserved words.

  var isReservedWord5 =
    makePredicate("class enum extends super const export import");

  // The additional reserved words in strict mode.

  var isStrictReservedWord =
    makePredicate("implements interface let package private " +
                  "protected public static yield");

  // The forbidden variable names in strict mode.

  var isStrictBadIdWord = makePredicate("eval arguments");

  // And the keywords.

  var isKeyword =
    makePredicate("break case catch continue debugger default do " +
                  "else finally for function if return switch throw try " +
                  "var while with null true false instanceof typeof void " +
                  "delete new in this");

  // ## Character categories

  // Big ugly regular expressions that match characters in the
  // whitespace, identifier, and identifier-start categories. These
  // are only applied when a character is found to actually have a
  // code point above 128.

  var nonASCIIwhitespace = /[\u1680\u180e\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/;
  var nonASCIIidentifierStartChars = "\xaa\xb5\xba\xc0-\xd6\xd8-\xf6\xf8-\u02c1\u02c6-\u02d1\u02e0-\u02e4\u02ec\u02ee\u0370-\u0374\u0376\u0377\u037a-\u037d\u0386\u0388-\u038a\u038c\u038e-\u03a1\u03a3-\u03f5\u03f7-\u0481\u048a-\u0527\u0531-\u0556\u0559\u0561-\u0587\u05d0-\u05ea\u05f0-\u05f2\u0620-\u064a\u066e\u066f\u0671-\u06d3\u06d5\u06e5\u06e6\u06ee\u06ef\u06fa-\u06fc\u06ff\u0710\u0712-\u072f\u074d-\u07a5\u07b1\u07ca-\u07ea\u07f4\u07f5\u07fa\u0800-\u0815\u081a\u0824\u0828\u0840-\u0858\u08a0\u08a2-\u08ac\u0904-\u0939\u093d\u0950\u0958-\u0961\u0971-\u0977\u0979-\u097f\u0985-\u098c\u098f\u0990\u0993-\u09a8\u09aa-\u09b0\u09b2\u09b6-\u09b9\u09bd\u09ce\u09dc\u09dd\u09df-\u09e1\u09f0\u09f1\u0a05-\u0a0a\u0a0f\u0a10\u0a13-\u0a28\u0a2a-\u0a30\u0a32\u0a33\u0a35\u0a36\u0a38\u0a39\u0a59-\u0a5c\u0a5e\u0a72-\u0a74\u0a85-\u0a8d\u0a8f-\u0a91\u0a93-\u0aa8\u0aaa-\u0ab0\u0ab2\u0ab3\u0ab5-\u0ab9\u0abd\u0ad0\u0ae0\u0ae1\u0b05-\u0b0c\u0b0f\u0b10\u0b13-\u0b28\u0b2a-\u0b30\u0b32\u0b33\u0b35-\u0b39\u0b3d\u0b5c\u0b5d\u0b5f-\u0b61\u0b71\u0b83\u0b85-\u0b8a\u0b8e-\u0b90\u0b92-\u0b95\u0b99\u0b9a\u0b9c\u0b9e\u0b9f\u0ba3\u0ba4\u0ba8-\u0baa\u0bae-\u0bb9\u0bd0\u0c05-\u0c0c\u0c0e-\u0c10\u0c12-\u0c28\u0c2a-\u0c33\u0c35-\u0c39\u0c3d\u0c58\u0c59\u0c60\u0c61\u0c85-\u0c8c\u0c8e-\u0c90\u0c92-\u0ca8\u0caa-\u0cb3\u0cb5-\u0cb9\u0cbd\u0cde\u0ce0\u0ce1\u0cf1\u0cf2\u0d05-\u0d0c\u0d0e-\u0d10\u0d12-\u0d3a\u0d3d\u0d4e\u0d60\u0d61\u0d7a-\u0d7f\u0d85-\u0d96\u0d9a-\u0db1\u0db3-\u0dbb\u0dbd\u0dc0-\u0dc6\u0e01-\u0e30\u0e32\u0e33\u0e40-\u0e46\u0e81\u0e82\u0e84\u0e87\u0e88\u0e8a\u0e8d\u0e94-\u0e97\u0e99-\u0e9f\u0ea1-\u0ea3\u0ea5\u0ea7\u0eaa\u0eab\u0ead-\u0eb0\u0eb2\u0eb3\u0ebd\u0ec0-\u0ec4\u0ec6\u0edc-\u0edf\u0f00\u0f40-\u0f47\u0f49-\u0f6c\u0f88-\u0f8c\u1000-\u102a\u103f\u1050-\u1055\u105a-\u105d\u1061\u1065\u1066\u106e-\u1070\u1075-\u1081\u108e\u10a0-\u10c5\u10c7\u10cd\u10d0-\u10fa\u10fc-\u1248\u124a-\u124d\u1250-\u1256\u1258\u125a-\u125d\u1260-\u1288\u128a-\u128d\u1290-\u12b0\u12b2-\u12b5\u12b8-\u12be\u12c0\u12c2-\u12c5\u12c8-\u12d6\u12d8-\u1310\u1312-\u1315\u1318-\u135a\u1380-\u138f\u13a0-\u13f4\u1401-\u166c\u166f-\u167f\u1681-\u169a\u16a0-\u16ea\u16ee-\u16f0\u1700-\u170c\u170e-\u1711\u1720-\u1731\u1740-\u1751\u1760-\u176c\u176e-\u1770\u1780-\u17b3\u17d7\u17dc\u1820-\u1877\u1880-\u18a8\u18aa\u18b0-\u18f5\u1900-\u191c\u1950-\u196d\u1970-\u1974\u1980-\u19ab\u19c1-\u19c7\u1a00-\u1a16\u1a20-\u1a54\u1aa7\u1b05-\u1b33\u1b45-\u1b4b\u1b83-\u1ba0\u1bae\u1baf\u1bba-\u1be5\u1c00-\u1c23\u1c4d-\u1c4f\u1c5a-\u1c7d\u1ce9-\u1cec\u1cee-\u1cf1\u1cf5\u1cf6\u1d00-\u1dbf\u1e00-\u1f15\u1f18-\u1f1d\u1f20-\u1f45\u1f48-\u1f4d\u1f50-\u1f57\u1f59\u1f5b\u1f5d\u1f5f-\u1f7d\u1f80-\u1fb4\u1fb6-\u1fbc\u1fbe\u1fc2-\u1fc4\u1fc6-\u1fcc\u1fd0-\u1fd3\u1fd6-\u1fdb\u1fe0-\u1fec\u1ff2-\u1ff4\u1ff6-\u1ffc\u2071\u207f\u2090-\u209c\u2102\u2107\u210a-\u2113\u2115\u2119-\u211d\u2124\u2126\u2128\u212a-\u212d\u212f-\u2139\u213c-\u213f\u2145-\u2149\u214e\u2160-\u2188\u2c00-\u2c2e\u2c30-\u2c5e\u2c60-\u2ce4\u2ceb-\u2cee\u2cf2\u2cf3\u2d00-\u2d25\u2d27\u2d2d\u2d30-\u2d67\u2d6f\u2d80-\u2d96\u2da0-\u2da6\u2da8-\u2dae\u2db0-\u2db6\u2db8-\u2dbe\u2dc0-\u2dc6\u2dc8-\u2dce\u2dd0-\u2dd6\u2dd8-\u2dde\u2e2f\u3005-\u3007\u3021-\u3029\u3031-\u3035\u3038-\u303c\u3041-\u3096\u309d-\u309f\u30a1-\u30fa\u30fc-\u30ff\u3105-\u312d\u3131-\u318e\u31a0-\u31ba\u31f0-\u31ff\u3400-\u4db5\u4e00-\u9fcc\ua000-\ua48c\ua4d0-\ua4fd\ua500-\ua60c\ua610-\ua61f\ua62a\ua62b\ua640-\ua66e\ua67f-\ua697\ua6a0-\ua6ef\ua717-\ua71f\ua722-\ua788\ua78b-\ua78e\ua790-\ua793\ua7a0-\ua7aa\ua7f8-\ua801\ua803-\ua805\ua807-\ua80a\ua80c-\ua822\ua840-\ua873\ua882-\ua8b3\ua8f2-\ua8f7\ua8fb\ua90a-\ua925\ua930-\ua946\ua960-\ua97c\ua984-\ua9b2\ua9cf\uaa00-\uaa28\uaa40-\uaa42\uaa44-\uaa4b\uaa60-\uaa76\uaa7a\uaa80-\uaaaf\uaab1\uaab5\uaab6\uaab9-\uaabd\uaac0\uaac2\uaadb-\uaadd\uaae0-\uaaea\uaaf2-\uaaf4\uab01-\uab06\uab09-\uab0e\uab11-\uab16\uab20-\uab26\uab28-\uab2e\uabc0-\uabe2\uac00-\ud7a3\ud7b0-\ud7c6\ud7cb-\ud7fb\uf900-\ufa6d\ufa70-\ufad9\ufb00-\ufb06\ufb13-\ufb17\ufb1d\ufb1f-\ufb28\ufb2a-\ufb36\ufb38-\ufb3c\ufb3e\ufb40\ufb41\ufb43\ufb44\ufb46-\ufbb1\ufbd3-\ufd3d\ufd50-\ufd8f\ufd92-\ufdc7\ufdf0-\ufdfb\ufe70-\ufe74\ufe76-\ufefc\uff21-\uff3a\uff41-\uff5a\uff66-\uffbe\uffc2-\uffc7\uffca-\uffcf\uffd2-\uffd7\uffda-\uffdc";
  var nonASCIIidentifierChars = "\u0371-\u0374\u0483-\u0487\u0591-\u05bd\u05bf\u05c1\u05c2\u05c4\u05c5\u05c7\u0610-\u061a\u0620-\u0649\u0672-\u06d3\u06e7-\u06e8\u06fb-\u06fc\u0730-\u074a\u0800-\u0814\u081b-\u0823\u0825-\u0827\u0829-\u082d\u0840-\u0857\u08e4-\u08fe\u0900-\u0903\u093a-\u093c\u093e-\u094f\u0951-\u0957\u0962-\u0963\u0966-\u096f\u0981-\u0983\u09bc\u09be-\u09c4\u09c7\u09c8\u09d7\u09df-\u09e0\u0a01-\u0a03\u0a3c\u0a3e-\u0a42\u0a47\u0a48\u0a4b-\u0a4d\u0a51\u0a66-\u0a71\u0a75\u0a81-\u0a83\u0abc\u0abe-\u0ac5\u0ac7-\u0ac9\u0acb-\u0acd\u0ae2-\u0ae3\u0ae6-\u0aef\u0b01-\u0b03\u0b3c\u0b3e-\u0b44\u0b47\u0b48\u0b4b-\u0b4d\u0b56\u0b57\u0b5f-\u0b60\u0b66-\u0b6f\u0b82\u0bbe-\u0bc2\u0bc6-\u0bc8\u0bca-\u0bcd\u0bd7\u0be6-\u0bef\u0c01-\u0c03\u0c46-\u0c48\u0c4a-\u0c4d\u0c55\u0c56\u0c62-\u0c63\u0c66-\u0c6f\u0c82\u0c83\u0cbc\u0cbe-\u0cc4\u0cc6-\u0cc8\u0cca-\u0ccd\u0cd5\u0cd6\u0ce2-\u0ce3\u0ce6-\u0cef\u0d02\u0d03\u0d46-\u0d48\u0d57\u0d62-\u0d63\u0d66-\u0d6f\u0d82\u0d83\u0dca\u0dcf-\u0dd4\u0dd6\u0dd8-\u0ddf\u0df2\u0df3\u0e34-\u0e3a\u0e40-\u0e45\u0e50-\u0e59\u0eb4-\u0eb9\u0ec8-\u0ecd\u0ed0-\u0ed9\u0f18\u0f19\u0f20-\u0f29\u0f35\u0f37\u0f39\u0f41-\u0f47\u0f71-\u0f84\u0f86-\u0f87\u0f8d-\u0f97\u0f99-\u0fbc\u0fc6\u1000-\u1029\u1040-\u1049\u1067-\u106d\u1071-\u1074\u1082-\u108d\u108f-\u109d\u135d-\u135f\u170e-\u1710\u1720-\u1730\u1740-\u1750\u1772\u1773\u1780-\u17b2\u17dd\u17e0-\u17e9\u180b-\u180d\u1810-\u1819\u1920-\u192b\u1930-\u193b\u1951-\u196d\u19b0-\u19c0\u19c8-\u19c9\u19d0-\u19d9\u1a00-\u1a15\u1a20-\u1a53\u1a60-\u1a7c\u1a7f-\u1a89\u1a90-\u1a99\u1b46-\u1b4b\u1b50-\u1b59\u1b6b-\u1b73\u1bb0-\u1bb9\u1be6-\u1bf3\u1c00-\u1c22\u1c40-\u1c49\u1c5b-\u1c7d\u1cd0-\u1cd2\u1d00-\u1dbe\u1e01-\u1f15\u200c\u200d\u203f\u2040\u2054\u20d0-\u20dc\u20e1\u20e5-\u20f0\u2d81-\u2d96\u2de0-\u2dff\u3021-\u3028\u3099\u309a\ua640-\ua66d\ua674-\ua67d\ua69f\ua6f0-\ua6f1\ua7f8-\ua800\ua806\ua80b\ua823-\ua827\ua880-\ua881\ua8b4-\ua8c4\ua8d0-\ua8d9\ua8f3-\ua8f7\ua900-\ua909\ua926-\ua92d\ua930-\ua945\ua980-\ua983\ua9b3-\ua9c0\uaa00-\uaa27\uaa40-\uaa41\uaa4c-\uaa4d\uaa50-\uaa59\uaa7b\uaae0-\uaae9\uaaf2-\uaaf3\uabc0-\uabe1\uabec\uabed\uabf0-\uabf9\ufb20-\ufb28\ufe00-\ufe0f\ufe20-\ufe26\ufe33\ufe34\ufe4d-\ufe4f\uff10-\uff19\uff3f";
  var nonASCIIidentifierStart = new RegExp("[" + nonASCIIidentifierStartChars + "]");
  var nonASCIIidentifier = new RegExp("[" + nonASCIIidentifierStartChars + nonASCIIidentifierChars + "]");

  // Whether a single character denotes a newline.

  var newline = /[\n\r\u2028\u2029]/;

  // Matches a whole line break (where CRLF is considered a single
  // line break). Used to count lines.

  var lineBreak = /\r\n|[\n\r\u2028\u2029]/g;

  // Test whether a given character code starts an identifier.

  function isIdentifierStart(code) {
    if (code < 65) return code === 36;
    if (code < 91) return true;
    if (code < 97) return code === 95;
    if (code < 123)return true;
    return code >= 0xaa &&
      nonASCIIidentifierStart.test(String.fromCharCode(code));
  }

  // Test whether a given character is part of an identifier.

  function isIdentifierChar(code) {
    if (code < 48) return code === 36;
    if (code < 58) return true;
    if (code < 65) return false;
    if (code < 91) return true;
    if (code < 97) return code === 95;
    if (code < 123)return true;
    return code >= 0xaa && nonASCIIidentifier.test(String.fromCharCode(code));
  }

  // ## Tokenizer

  // Reset the token state. Used at the start of a parse.

  function initTokenState() {
    tokPos = 0;
    tokRegexpAllowed = true;
    skipSpace();
  }

  // Called at the end of every token. Sets `tokEnd`, `tokVal`, and
  // `tokRegexpAllowed`, and skips the space after the token, so that
  // the next one's `tokStart` will point at the right position.

  function finishToken(type, val) {
    tokEnd = tokPos;
    tokType = type;
    skipSpace();
    tokVal = val;
    tokRegexpAllowed = type.beforeExpr;
  }

  function skipBlockComment() {
    var end = input.indexOf("*/", tokPos += 2);
    if (end === -1) raise(tokPos - 2, "Unterminated comment");
    tokPos = end + 2;
  }

  function skipLineComment() {
    var ch = input.charCodeAt(tokPos+=2);
    while (tokPos < inputLen && ch !== 10 &&
           ch !== 13 && ch !== 8232 && ch !== 8329) {
      ++tokPos;
      ch = input.charCodeAt(tokPos);
    }
  }

  // Called at the start of the parse and after every token. Skips
  // whitespace and comments, and.

  function skipSpace() {
    while (tokPos < inputLen) {
      var ch = input.charCodeAt(tokPos);
      if (ch === 32) { // ' '
        ++tokPos;
      } else if(ch === 13) {
        ++tokPos;
        var next = input.charCodeAt(tokPos);
        if(next === 10) {
          ++tokPos;
        }
      } else if (ch === 10) {
        ++tokPos;
      } else if(ch < 14 && ch > 8) {
        ++tokPos;
      } else if (ch === 47) { // '/'
        var next = input.charCodeAt(tokPos+1);
        if (next === 42) { // '*'
          skipBlockComment();
        } else if (next === 47) { // '/'
          skipLineComment();
        } else break;
      } else if ((ch < 14 && ch > 8) ||
                 ch === 32 || ch === 160) { // ' ', '\xa0'
        ++tokPos;
      } else if (ch >= 5760 &&
                 nonASCIIwhitespace.test(String.fromCharCode(ch))) {
        ++tokPos;
      } else {
        break;
      }
    }
  }

  // ### Token reading

  // This is the function that is called to fetch the next token. It
  // is somewhat obscure, because it works in character codes rather
  // than characters, and because operator parsing has been inlined
  // into it.
  //
  // All in the name of speed.
  //
  // The `forceRegexp` parameter is used in the one case where the
  // `tokRegexpAllowed` trick does not work. See `parseStatement`.

  function readToken_dot() {
    var next = input.charCodeAt(tokPos+1);
    if (next >= 48 && next <= 57) return readNumber(true);
    ++tokPos;
    return finishToken(_dot);
  }

  function readToken_slash() { // '/'
    var next = input.charCodeAt(tokPos+1);
    if (tokRegexpAllowed) {++tokPos; return readRegexp();}
    if (next === 61) return finishOp(_assign, 2);
    return finishOp(_slash, 1);
  }

  function readToken_mult_modulo() { // '%', '*' and '**'
    var next = input.charCodeAt(tokPos+1);
    if (next === 61) return finishOp(_assign, 2);
    if (next === 42) {
      var next2 = input.charCodeAt(tokPos+2);
      if (next === 61) return finishOp(_assign, 3);
      return finishOp(_bin11, 2);
    }
    return finishOp(_bin10, 1);
  }

  function readToken_pipe_amp(code) { // '|&'
    var next = input.charCodeAt(tokPos+1);
    if (next === code) return finishOp(code === 124 ? _bin1 : _bin2, 2);
    if (next === 61) return finishOp(_assign, 2);
    return finishOp(code === 124 ? _bin3 : _bin5, 1);
  }

  function readToken_caret() { // '^'
    var next = input.charCodeAt(tokPos+1);
    if (next === 61) return finishOp(_assign, 2);
    return finishOp(_bin4, 1);
  }

  function readToken_plus_min(code) { // '+-'
    var next = input.charCodeAt(tokPos+1);
    if (next === code) return finishOp(_incdec, 2);
    if (next === 61) return finishOp(_assign, 2);
    return finishOp(_plusmin, 1);
  }

  function readToken_lt_gt(code) { // '<>'
    var next = input.charCodeAt(tokPos+1);
    var size = 1;
    if (next === code) {
      size = code === 62 && input.charCodeAt(tokPos+2) === 62 ? 3 : 2;
      if (input.charCodeAt(tokPos + size) === 61)
        return finishOp(_assign, size + 1);
      return finishOp(_bin8, size);
    }
    if (next === 61)
      size = input.charCodeAt(tokPos+2) === 61 ? 3 : 2;
    return finishOp(_bin7, size);
  }

  function readToken_eq_excl(code) { // '=!'
    var next = input.charCodeAt(tokPos+1);
    if (next === 61)
      return finishOp(_bin6, input.charCodeAt(tokPos+2) === 61 ? 3 : 2);
    return finishOp(code === 61 ? _eq : _prefix, 1);
  }

  function getTokenFromCode(code) {
    switch(code) {
      // The interpretation of a dot depends on whether it is followed
      // by a digit.
    case 46: // '.'
      return readToken_dot();

      // Punctuation tokens.
    case 35: ++tokPos; return finishToken(_hash);
    case 40: ++tokPos; return finishToken(_parenL);
    case 41: ++tokPos; return finishToken(_parenR);
    case 59: ++tokPos; return finishToken(_semi);
    case 44: ++tokPos; return finishToken(_comma);
    case 91: ++tokPos; return finishToken(_bracketL);
    case 93: ++tokPos; return finishToken(_bracketR);
    case 123: ++tokPos; return finishToken(_braceL);
    case 125: ++tokPos; return finishToken(_braceR);
    case 58: ++tokPos; return finishToken(_colon);
    case 63: ++tokPos; return finishToken(_question);

      // '0x' is a hexadecimal number.
    case 48: // '0'
      var next = input.charCodeAt(tokPos+1);
      if (next === 120 || next === 88) return readHexNumber();
      // Anything else beginning with a digit is an integer, octal
      // number, or float.
    case 49: case 50: case 51: case 52: case 53:
    case 54: case 55: case 56: case 57: // 1-9
      return readNumber(false);

      // Quotes produce strings.
    case 34: case 39: // '"', "'"
      return readString(code);

    // Operators are parsed inline in tiny state machines. '=' (61) is
    // often referred to. `finishOp` simply skips the amount of
    // characters it is given as second argument, and returns a token
    // of the type given by its first argument.

    case 47: // '/'
      return readToken_slash(code);

    case 37: case 42: // '%*'
      return readToken_mult_modulo();

    case 124: case 38: // '|&'
      return readToken_pipe_amp(code);

    case 94: // '^'
      return readToken_caret();

    case 43: case 45: // '+-'
      return readToken_plus_min(code);

    case 60: case 62: // '<>'
      return readToken_lt_gt(code);

    case 61: case 33: // '=!'
      return readToken_eq_excl(code);

    case 126: // '~'
      return finishOp(_prefix, 1);
    }

    return false;
  }

  function readToken(forceRegexp) {
    tokStart = tokPos;
    if (forceRegexp) return readRegexp();
    if (tokPos >= inputLen) return finishToken(_eof);

    var code = input.charCodeAt(tokPos);
    // Identifier or keyword. '\uXXXX' sequences are allowed in
    // identifiers, so '\' also dispatches to that.
    if (isIdentifierStart(code) || code === 92 /* '\' */) return readWord();

    var tok = getTokenFromCode(code);

    if (tok === false) {
      // If we are here, we either found a non-ASCII identifier
      // character, or something that's entirely disallowed.
      var ch = String.fromCharCode(code);
      if (ch === "\\" || nonASCIIidentifierStart.test(ch)) return readWord();
      raise(tokPos, "Unexpected character '" + ch + "'");
    }
    return tok;
  }

  function finishOp(type, size) {
    var str = input.slice(tokPos, tokPos + size);
    tokPos += size;
    finishToken(type, str);
  }

  // Parse a regular expression. Some context-awareness is necessary,
  // since a '/' inside a '[]' set does not end the expression.

  function readRegexp() {
    var content = "", escaped, inClass, start = tokPos;
    for (;;) {
      if (tokPos >= inputLen) raise(start, "Unterminated regular expression");
      var ch = input.charAt(tokPos);
      if (newline.test(ch)) raise(start, "Unterminated regular expression");
      if (!escaped) {
        if (ch === "[") inClass = true;
        else if (ch === "]" && inClass) inClass = false;
        else if (ch === "/" && !inClass) break;
        escaped = ch === "\\";
      } else escaped = false;
      ++tokPos;
    }
    var content = input.slice(start, tokPos);
    ++tokPos;
    // Need to use `readWord1` because '\uXXXX' sequences are allowed
    // here (don't ask).
    var mods = readWord1();
    if (mods && !/^[gmsiy]*$/.test(mods)) raise(start, "Invalid regexp flag");
    return finishToken(_regexp, new RegExp(content, mods));
  }

  // Read an integer in the given radix. Return null if zero digits
  // were read, the integer value otherwise. When `len` is given, this
  // will return `null` unless the integer has exactly `len` digits.

  function readInt(radix, len) {
    var start = tokPos, total = 0;
    for (var i = 0, e = len == null ? Infinity : len; i < e; ++i) {
      var code = input.charCodeAt(tokPos), val;
      if (code >= 97) val = code - 97 + 10; // a
      else if (code >= 65) val = code - 65 + 10; // A
      else if (code >= 48 && code <= 57) val = code - 48; // 0-9
      else val = Infinity;
      if (val >= radix) break;
      ++tokPos;
      total = total * radix + val;
    }
    if (tokPos === start || len != null && tokPos - start !== len) return null;

    return total;
  }

  function readHexNumber() {
    tokPos += 2; // 0x
    var val = readInt(16);
    if (val == null) raise(tokStart + 2, "Expected hexadecimal number");
    if (isIdentifierStart(input.charCodeAt(tokPos)))
      raise(tokPos, "Identifier directly after number");
    return finishToken(_num, val);
  }

  // Read an integer, octal integer, or floating-point number.

  function readNumber(startsWithDot) {
    var start = tokPos, isFloat = false;
    var octal = input.charCodeAt(tokPos) === 48;
    if (!startsWithDot && readInt(10) === null) raise(start, "Invalid number");
    if (input.charCodeAt(tokPos) === 46) {
      ++tokPos;
      readInt(10);
      isFloat = true;
    }
    var next = input.charCodeAt(tokPos);
    if (next === 69 || next === 101) { // 'eE'
      next = input.charCodeAt(++tokPos);
      if (next === 43 || next === 45) ++tokPos; // '+-'
      if (readInt(10) === null) raise(start, "Invalid number")
      isFloat = true;
    }
    if (isIdentifierStart(input.charCodeAt(tokPos)))
      raise(tokPos, "Identifier directly after number");

    var str = input.slice(start, tokPos), val;
    if (isFloat) val = parseFloat(str);
    else if (!octal || str.length === 1) val = parseInt(str, 10);
    else if (/[89]/.test(str) || strict) raise(start, "Invalid number");
    else val = parseInt(str, 8);
    return finishToken(_num, val);
  }

  // Read a string value, interpreting backslash-escapes.

  var rs_str = [];

  function readString(quote) {
    tokPos++;
    rs_str.length = 0;
    for (;;) {
      if (tokPos >= inputLen) raise(tokStart, "Unterminated string constant");
      var ch = input.charCodeAt(tokPos);
      if (ch === quote) {
        ++tokPos;
        return finishToken(_string, String.fromCharCode.apply(null, rs_str));
      }
      if (ch === 92) { // '\'
        ch = input.charCodeAt(++tokPos);
        var octal = /^[0-7]+/.exec(input.slice(tokPos, tokPos + 3));
        if (octal) octal = octal[0];
        while (octal && parseInt(octal, 8) > 255)
          octal = octal.slice(0, octal.length - 1);
        if (octal === "0") octal = null;
        ++tokPos;
        if (octal) {
          if (strict) raise(tokPos - 2, "Octal literal in strict mode");
          rs_str.push(parseInt(octal, 8));
          tokPos += octal.length - 1;
        } else {
          switch (ch) {
          case 110: rs_str.push(10); break; // 'n' -> '\n'
          case 114: rs_str.push(13); break; // 'r' -> '\r'
          case 120: rs_str.push(readHexChar(2)); break; // 'x'
          case 117: rs_str.push(readHexChar(4)); break; // 'u'
          case 85: rs_str.push(readHexChar(8)); break; // 'U'
          case 116: rs_str.push(9); break; // 't' -> '\t'
          case 98: rs_str.push(8); break; // 'b' -> '\b'
          case 118: rs_str.push(11); break; // 'v' -> '\u000b'
          case 102: rs_str.push(12); break; // 'f' -> '\f'
          case 48: rs_str.push(0); break; // 0 -> '\0'
          case 13: if (input.charCodeAt(tokPos) === 10) ++tokPos; // '\r\n'
          case 10: // ' \n'
            break;
          default: rs_str.push(ch); break;
          }
        }
      } else {
        if (ch === 13 || ch === 10 || ch === 8232 || ch === 8329)
          raise(tokStart, "Unterminated string constant");
        rs_str.push(ch); // '\'
        ++tokPos;
      }
    }
  }

  // Used to read character escape sequences ('\x', '\u', '\U').

  function readHexChar(len) {
    var n = readInt(16, len);
    if (n === null) raise(tokStart, "Bad character escape sequence");
    return n;
  }

  // Used to signal to callers of `readWord1` whether the word
  // contained any escape sequences. This is needed because words with
  // escape sequences must not be interpreted as keywords.

  var containsEsc;

  // Read an identifier, and return it as a string. Sets `containsEsc`
  // to whether the word contained a '\u' escape.
  //
  // Only builds up the word character-by-character when it actually
  // containeds an escape, as a micro-optimization.

  function readWord1() {
    containsEsc = false;
    var word, first = true, start = tokPos;
    for (;;) {
      var ch = input.charCodeAt(tokPos);
      if (isIdentifierChar(ch)) {
        if (containsEsc) word += input.charAt(tokPos);
        ++tokPos;
      } else if (ch === 92) { // "\"
        if (!containsEsc) word = input.slice(start, tokPos);
        containsEsc = true;
        if (input.charCodeAt(++tokPos) != 117) // "u"
          raise(tokPos, "Expecting Unicode escape sequence \\uXXXX");
        ++tokPos;
        var esc = readHexChar(4);
        var escStr = String.fromCharCode(esc);
        if (!escStr) raise(tokPos - 1, "Invalid Unicode escape");
        if (!(first ? isIdentifierStart(esc) : isIdentifierChar(esc)))
          raise(tokPos - 4, "Invalid Unicode escape");
        word += escStr;
      } else {
        break;
      }
      first = false;
    }
    return containsEsc ? word : input.slice(start, tokPos);
  }

  // Read an identifier or keyword token. Will check for reserved
  // words when necessary.

  function readWord() {
    var word = readWord1();
    var type = _name;
    if (!containsEsc) {
      if (isKeyword(word)) type = keywordTypes[word];
      else if (strict && isStrictReservedWord(word))
        raise(tokStart, "The keyword '" + word + "' is reserved");
    }
    return finishToken(type, word);
  }

  // ## Parser

  // A recursive descent parser operates by defining functions for all
  // syntactic elements, and recursively calling those, each function
  // advancing the input stream and returning an AST node. Precedence
  // of constructs (for example, the fact that `!x[1]` means `!(x[1])`
  // instead of `(!x)[1]` is handled by the fact that the parser
  // function that parses unary prefix operators is called first, and
  // in turn calls the function that parses `[]` subscripts — that
  // way, it'll receive the node for `x[1]` already parsed, and wraps
  // *that* in the unary operator node.
  //
  // Acorn uses an [operator precedence parser][opp] to handle binary
  // operator precedence, because it is much more compact than using
  // the technique outlined above, which uses different, nesting
  // functions to specify precedence, for all of the ten binary
  // precedence levels that JavaScript defines.
  //
  // [opp]: http://en.wikipedia.org/wiki/Operator-precedence_parser

  // ### Parser utilities

  // Continue to the next token.

  function next() {
    lastStart = tokStart;
    lastEnd = tokEnd;
    readToken();
  }

  // Enter strict mode. Re-reads the next token to please pedantic
  // tests ("use strict"; 010; -- should fail).

  function setStrict(strct) {
    strict = strct;
    tokPos = lastEnd;
    skipSpace();
    readToken();
  }

  // Start an AST node, attaching a start offset.

  function node_t() {
    this.type = null;
    this.start = tokStart;
    this.end = null;
  }

  function node_loc_t() {
    this.start = tokStartLoc;
    this.end = null;
  }

  function startNode() { return new node_t(); }

  // Start a node whose start offset information should be based on
  // the start of another node. For example, a binary operator node is
  // only started after its left-hand side has already been parsed.

  function startNodeFrom(other) {
    var node = new node_t();
    node.start = other.start;

    return node;
  }

  // Finish an AST node, adding `type` and `end` properties.

  function finishNode(node, type) {
    node.type = type;
    node.end = lastEnd;
    return node;
  }

  // Test whether a statement node is the string literal `"use strict"`.

  function isUseStrict(stmt) {
    return stmt.type === "ExpressionStatement" &&
      stmt.expression.type === "Literal" &&
      stmt.expression.value === "use strict";
  }

  // Predicate that tests whether the next token is of the given
  // type, and if yes, consumes it as a side effect.

  function eat(type) {
    if (tokType === type) {
      next();
      return true;
    }
  }

  // Test whether a semicolon can be inserted at the current position.

  function canInsertSemicolon() {
    return (tokType === _eof || tokType === _braceR ||
            newline.test(input.slice(lastEnd, tokStart)));
  }

  // Consume a semicolon, or, failing that, see if we are allowed to
  // pretend that there is a semicolon at this position.

  function semicolon() {
    if (!eat(_semi) && !canInsertSemicolon()) unexpected();
  }

  // Expect a token of a given type. If found, consume it, otherwise,
  // raise an unexpected token error.

  function expect(type) {
    if (tokType === type) next();
    else unexpected();
  }

  // Raise an unexpected token error.

  function unexpected() {
    raise(tokStart, "Unexpected token");
  }

  // Verify that a node is an lval — something that can be assigned
  // to.

  function checkLVal(expr) {
    if (expr.type !== "Identifier" && expr.type !== "MemberExpression")
      raise(expr.start, "Assigning to rvalue");
    if (strict && expr.type === "Identifier" && isStrictBadIdWord(expr.name))
      raise(expr.start, "Assigning to " + expr.name + " in strict mode");
  }

  // ### Top level parsing

  // Parse an expression. Initializes the parser, reads a single
  // expression and returns it.

  function parseTopLevel() {
    lastStart = lastEnd = tokPos;
    inFunction = strict = null;
    labels = [];
    readToken();
    return parseExpression();
  }

  var loopLabel = {kind: "loop"}, switchLabel = {kind: "switch"};

  // Parse a single statement.
  //
  // If expecting a statement and finding a slash operator, parse a
  // regular expression literal. This is to handle cases like
  // `if (foo) /blah/.exec(foo);`, where looking at the previous token
  // does not help.

  function parseStatement() {
    if (tokType === _slash)
      readToken(true);

    var starttype = tokType, node = startNode();

    // Most types of statements are recognized by the keyword they
    // start with. Many are trivial to parse, some require a bit of
    // complexity.

    switch (starttype) {
    case _break: case _continue:
      next();
      var isBreak = starttype === _break;
      if (eat(_semi) || canInsertSemicolon()) node.label = null;
      else if (tokType !== _name) unexpected();
      else {
        node.label = parseIdent();
        semicolon();
      }

      // Verify that there is an actual destination to break or
      // continue to.
      for (var i = 0; i < labels.length; ++i) {
        var lab = labels[i];
        if (node.label == null || lab.name === node.label.name) {
          if (lab.kind != null && (isBreak || lab.kind === "loop")) break;
          if (node.label && isBreak) break;
        }
      }
      if (i === labels.length)
        raise(node.start, "Unsyntactic " + starttype.keyword);
      return finishNode(node, isBreak ? "BreakStatement" : "ContinueStatement");

    case _debugger:
      next();
      semicolon();
      return finishNode(node, "DebuggerStatement");

    case _do:
      next();
      labels.push(loopLabel);
      node.body = parseStatement();
      labels.pop();
      expect(_while);
      node.test = parseParenExpression();
      semicolon();
      return finishNode(node, "DoWhileStatement");

      // Disambiguating between a `for` and a `for`/`in` loop is
      // non-trivial. Basically, we have to parse the init `var`
      // statement or expression, disallowing the `in` operator (see
      // the second parameter to `parseExpression`), and then check
      // whether the next token is `in`. When there is no init part
      // (semicolon immediately after the opening parenthesis), it is
      // a regular `for` loop.

    case _for:
      next();
      labels.push(loopLabel);
      expect(_parenL);
      if (tokType === _semi) return parseFor(node, null);
      if (tokType === _var) {
        var init = startNode();
        next();
        parseVar(init, true);
        if (init.declarations.length === 1 && eat(_in))
          return parseForIn(node, init);
        return parseFor(node, init);
      }
      var init = parseExpression(false, true);
      if (eat(_in)) {checkLVal(init); return parseForIn(node, init);}
      return parseFor(node, init);

    case _function:
      next();
      return parseFunction(node, true);

    case _if:
      next();
      node.test = parseParenExpression();
      node.consequent = parseStatement();
      node.alternate = eat(_else) ? parseStatement() : null;
      return finishNode(node, "IfStatement");

    case _return:
      if (!inFunction) raise(tokStart, "'return' outside of function");
      next();

      // In `return` (and `break`/`continue`), the keywords with
      // optional arguments, we eagerly look for a semicolon or the
      // possibility to insert one.

      if (eat(_semi) || canInsertSemicolon()) node.argument = null;
      else { node.argument = parseExpression(); semicolon(); }
      return finishNode(node, "ReturnStatement");

    case _switch:
      next();
      node.discriminant = parseParenExpression();
      node.cases = [];
      expect(_braceL);
      labels.push(switchLabel);

      // Statements under must be grouped (by label) in SwitchCase
      // nodes. `cur` is used to keep the node that we are currently
      // adding statements to.

      for (var cur, sawDefault; tokType != _braceR;) {
        if (tokType === _case || tokType === _default) {
          var isCase = tokType === _case;
          if (cur) finishNode(cur, "SwitchCase");
          node.cases.push(cur = startNode());
          cur.consequent = [];
          next();
          if (isCase) cur.test = parseExpression();
          else {
            if (sawDefault)
              raise(lastStart, "Multiple default clauses"); sawDefault = true;
            cur.test = null;
          }
          expect(_colon);
        } else {
          if (!cur) unexpected();
          cur.consequent.push(parseStatement());
        }
      }
      if (cur) finishNode(cur, "SwitchCase");
      next(); // Closing brace
      labels.pop();
      return finishNode(node, "SwitchStatement");

    case _throw:
      next();
      if (newline.test(input.slice(lastEnd, tokStart)))
        raise(lastEnd, "Illegal newline after throw");
      node.argument = parseExpression();
      semicolon();
      return finishNode(node, "ThrowStatement");

    case _try:
      next();
      node.block = parseBlock();
      node.handlers = [];
      while (tokType === _catch) {
        var clause = startNode();
        next();
        expect(_parenL);
        clause.param = parseIdent();
        if (strict && isStrictBadIdWord(clause.param.name))
          raise(clause.param.start, "Binding " +
                clause.param.name + " in strict mode");
        expect(_parenR);
        clause.guard = null;
        clause.body = parseBlock();
        node.handlers.push(finishNode(clause, "CatchClause"));
      }
      node.finalizer = eat(_finally) ? parseBlock() : null;
      if (!node.handlers.length && !node.finalizer)
        raise(node.start, "Missing catch or finally clause");
      return finishNode(node, "TryStatement");

    case _var:
      next();
      node = parseVar(node);
      semicolon();
      return node;

    case _while:
      next();
      node.test = parseParenExpression();
      labels.push(loopLabel);
      node.body = parseStatement();
      labels.pop();
      return finishNode(node, "WhileStatement");

    case _with:
      if (strict) raise(tokStart, "'with' in strict mode");
      next();
      node.object = parseParenExpression();
      node.body = parseStatement();
      return finishNode(node, "WithStatement");

    case _braceL:
      return parseBlock();

    case _semi:
      next();
      return finishNode(node, "EmptyStatement");

      // If the statement does not start with a statement keyword or a
      // brace, it's an ExpressionStatement or LabeledStatement. We
      // simply start parsing an expression, and afterwards, if the
      // next token is a colon and the expression was a simple
      // Identifier node, we switch to interpreting it as a label.

    default:
      var maybeName = tokVal, expr = parseExpression();
      if (starttype === _name && expr.type === "Identifier" && eat(_colon)) {
        for (var i = 0; i < labels.length; ++i)
          if (labels[i].name === maybeName)
            raise(expr.start, "Label '" + maybeName + "' is already declared");
        var kind = tokType.isLoop ?
          "loop" : tokType === _switch ? "switch" : null;
        labels.push({name: maybeName, kind: kind});
        node.body = parseStatement();
        labels.pop();
        node.label = expr;
        return finishNode(node, "LabeledStatement");
      } else {
        node.expression = expr;
        semicolon();
        return finishNode(node, "ExpressionStatement");
      }
    }
  }

  // Used for constructs like `switch` and `if` that insist on
  // parentheses around their expression.

  function parseParenExpression() {
    expect(_parenL);
    var val = parseExpression();
    expect(_parenR);
    return val;
  }

  // Parse a semicolon-enclosed block of statements, handling `"use
  // strict"` declarations when `allowStrict` is true (used for
  // function bodies).

  function parseBlock(allowStrict) {
    var node = startNode(), first = true, strict = false, oldStrict;
    node.body = [];
    expect(_braceL);
    while (!eat(_braceR)) {
      var stmt = parseStatement();
      node.body.push(stmt);
      if (first && isUseStrict(stmt)) {
        oldStrict = strict;
        setStrict(strict = true);
      }
      first = false
    }
    if (strict && !oldStrict) setStrict(false);
    return finishNode(node, "BlockStatement");
  }

  // Parse a regular `for` loop. The disambiguation code in
  // `parseStatement` will already have parsed the init statement or
  // expression.

  function parseFor(node, init) {
    node.init = init;
    expect(_semi);
    node.test = tokType === _semi ? null : parseExpression();
    expect(_semi);
    node.update = tokType === _parenR ? null : parseExpression();
    expect(_parenR);
    node.body = parseStatement();
    labels.pop();
    return finishNode(node, "ForStatement");
  }

  // Parse a `for`/`in` loop.

  function parseForIn(node, init) {
    node.left = init;
    node.right = parseExpression();
    expect(_parenR);
    node.body = parseStatement();
    labels.pop();
    return finishNode(node, "ForInStatement");
  }

  // Parse a list of variable declarations.

  function parseVar(node, noIn) {
    node.declarations = [];
    node.kind = "var";
    for (;;) {
      var decl = startNode();
      decl.id = parseIdent();
      if (strict && isStrictBadIdWord(decl.id.name))
        raise(decl.id.start, "Binding " + decl.id.name + " in strict mode");
      decl.init = eat(_eq) ? parseExpression(true, noIn) : null;
      node.declarations.push(finishNode(decl, "VariableDeclarator"));
      if (!eat(_comma)) break;
    }
    return finishNode(node, "VariableDeclaration");
  }

  // ### Expression parsing

  // These nest, from the most general expression type at the top to
  // 'atomic', nondivisible expression types at the bottom. Most of
  // the functions will simply let the function(s) below them parse,
  // and, *if* the syntactic construct they handle is present, wrap
  // the AST node that the inner parser gave them in another node.

  // Parse a full expression. The arguments are used to forbid comma
  // sequences (in argument lists, array literals, or object literals)
  // or the `in` operator (in for loops initalization expressions).

  function parseExpression(noComma, noIn) {
    var expr = parseMaybeAssign(noIn);
    if (!noComma && tokType === _comma) {
      var node = startNodeFrom(expr);
      node.expressions = [expr];
      while (eat(_comma)) node.expressions.push(parseMaybeAssign(noIn));
      return finishNode(node, "SequenceExpression");
    }
    return expr;
  }

  // Parse an assignment expression. This includes applications of
  // operators like `+=`.

  function parseMaybeAssign(noIn) {
    var left = parseMaybeConditional(noIn);
    if (tokType.isAssign) {
      var node = startNodeFrom(left);
      node.operator = tokVal;
      node.left = left;
      next();
      node.right = parseMaybeAssign(noIn);
      checkLVal(left);
      return finishNode(node, "AssignmentExpression");
    }
    return left;
  }

  // Parse a ternary conditional (`?:`) operator.

  function parseMaybeConditional(noIn) {
    var expr = parseExprOps(noIn);
    if (eat(_question)) {
      var node = startNodeFrom(expr);
      node.test = expr;
      node.consequent = parseExpression(true);
      expect(_colon);
      node.alternate = parseExpression(true, noIn);
      return finishNode(node, "ConditionalExpression");
    }
    return expr;
  }

  // Start the precedence parser.

  function parseExprOps(noIn) {
    return parseExprOp(parseMaybeUnary(noIn), -1, noIn);
  }

  // Parse binary operators with the operator precedence parsing
  // algorithm. `left` is the left-hand side of the operator.
  // `minPrec` provides context that allows the function to stop and
  // defer further parser to one of its callers when it encounters an
  // operator that has a lower precedence than the set it is parsing.

  function parseExprOp(left, minPrec, noIn) {
    var prec = tokType.binop;
    if (prec != null && (!noIn || tokType !== _in)) {
      if (prec > minPrec) {
        var node = startNodeFrom(left);
        node.left = left;
        node.operator = tokVal;
        next();
        node.right = parseExprOp(parseMaybeUnary(noIn), prec, noIn);
        var node = finishNode(node, /&&|\|\|/.test(node.operator) ?
                              "LogicalExpression" : "BinaryExpression");
        return parseExprOp(node, minPrec, noIn);
      }
    }
    return left;
  }

  // Parse unary operators, both prefix and postfix.

  function parseMaybeUnary(noIn) {
    if (tokType.prefix) {
      var node = startNode(), update = tokType.isUpdate;
      node.operator = tokVal;
      node.prefix = true;
      next();
      node.argument = parseMaybeUnary(noIn);
      if (update) checkLVal(node.argument);
      else if (strict && node.operator === "delete" &&
               node.argument.type === "Identifier")
        raise(node.start, "Deleting local variable in strict mode");
      return finishNode(node, update ? "UpdateExpression" : "UnaryExpression");
    }
    var expr = parseExprSubscripts();
    while (tokType.postfix && !canInsertSemicolon()) {
      var node = startNodeFrom(expr);
      node.operator = tokVal;
      node.prefix = false;
      node.argument = expr;
      checkLVal(expr);
      next();
      expr = finishNode(node, "UpdateExpression");
    }
    return expr;
  }

  // Parse call, dot, and `[]`-subscript expressions.

  function parseExprSubscripts() {
    return parseSubscripts(parseExprAtom());
  }

  function parseSubscripts(base, noCalls) {
    if (eat(_dot)) {
      var node = startNodeFrom(base);
      node.object = base;
      node.property = parseIdent(true);
      node.computed = false;
      return parseSubscripts(finishNode(node, "MemberExpression"), noCalls);
    } else if (eat(_hash)) {
      var node = startNodeFrom(base);
      node.object = base;
      node.property = parseIdentOrNum(true);
      node.computed = node.property.type == "Literal";
      return parseSubscripts(finishNode(node, "PluckExpression"), noCalls);
    } else if (eat(_bracketL)) {
      var node = startNodeFrom(base);
      node.object = base;
      node.property = parseExpression();
      node.computed = true;
      expect(_bracketR);
      return parseSubscripts(finishNode(node, "MemberExpression"), noCalls);
    } else if (!noCalls && eat(_parenL)) {
      var node = startNodeFrom(base);
      node.callee = base;
      node.arguments = parseExprList(_parenR);
      return parseSubscripts(finishNode(node, "CallExpression"), noCalls);
    } else return base;
  }

  // Parse a number or an identifier (used for pluck expressions).

  function parseIdentOrNum() {
    switch (tokType) {
    case _name:
      return parseIdent();
    case _num: case _string: case _regexp:
      var node = startNode();
      node.value = tokVal;
      node.raw = input.slice(tokStart, tokEnd);
      next();
      return finishNode(node, "Literal");

    default:
      unexpected();
    }
  }

  // Parse an atomic expression — either a single token that is an
  // expression, an expression started by a keyword like `function` or
  // `new`, or an expression wrapped in punctuation like `()`, `[]`,
  // or `{}`.

  function parseExprAtom() {
    switch (tokType) {
    case _this:
      var node = startNode();
      next();
      return finishNode(node, "ThisExpression");
    case _name:
      return parseIdent();
    case _num: case _string: case _regexp:
      var node = startNode();
      node.value = tokVal;
      node.raw = input.slice(tokStart, tokEnd);
      next();
      return finishNode(node, "Literal");

    case _null: case _true: case _false:
      var node = startNode();
      node.value = tokType.atomValue;
      node.raw = tokType.keyword
      next();
      return finishNode(node, "Literal");

    case _parenL:
      var tokStartLoc1 = tokStartLoc, tokStart1 = tokStart;
      next();
      var val = parseExpression();
      val.start = tokStart1;
      val.end = tokEnd;
      expect(_parenR);
      return val;

    case _bracketL:
      var node = startNode();
      next();
      node.elements = parseExprList(_bracketR, true);
      return finishNode(node, "ArrayExpression");

    case _braceL:
      return parseObj();

    case _function:
      var node = startNode();
      next();
      return parseFunction(node, false);

    case _new:
      return parseNew();

    default:
      unexpected();
    }
  }

  // New's precedence is slightly tricky. It must allow its argument
  // to be a `[]` or dot subscript expression, but not a call — at
  // least, not without wrapping it in parentheses. Thus, it uses the

  function parseNew() {
    var node = startNode();
    next();
    node.callee = parseSubscripts(parseExprAtom(), true);
    if (eat(_parenL)) node.arguments = parseExprList(_parenR);
    else node.arguments = [];
    return finishNode(node, "NewExpression");
  }

  // Parse an object literal.

  function parseObj() {
    var node = startNode(), first = true, sawGetSet = false;
    node.properties = [];
    next();
    while (!eat(_braceR)) {
      if (!first) {
        expect(_comma);
      } else first = false;

      var prop = {key: parsePropertyName()}, isGetSet = false, kind;
      if (eat(_colon)) {
        prop.value = parseExpression(true);
        kind = prop.kind = "init";
      } else if (prop.key.type === "Identifier" &&
                 (prop.key.name === "get" || prop.key.name === "set")) {
        isGetSet = sawGetSet = true;
        kind = prop.kind = prop.key.name;
        prop.key = parsePropertyName();
        if (tokType !== _parenL) unexpected();
        prop.value = parseFunction(startNode(), false);
      } else unexpected();

      // getters and setters are not allowed to clash — either with
      // each other or with an init property — and in strict mode,
      // init properties are also not allowed to be repeated.

      if (prop.key.type === "Identifier" && (strict || sawGetSet)) {
        for (var i = 0; i < node.properties.length; ++i) {
          var other = node.properties[i];
          if (other.key.name === prop.key.name) {
            var conflict = kind == other.kind ||
              isGetSet && other.kind === "init" ||
              kind === "init" && (other.kind === "get" || other.kind === "set");
            if (conflict && !strict && kind === "init" &&
                other.kind === "init") conflict = false;
            if (conflict) raise(prop.key.start, "Redefinition of property");
          }
        }
      }
      node.properties.push(prop);
    }
    return finishNode(node, "ObjectExpression");
  }

  function parsePropertyName() {
    if (tokType === _num || tokType === _string) return parseExprAtom();
    return parseIdent(true);
  }

  // Parse a function declaration or literal (depending on the
  // `isStatement` parameter).

  function parseFunction(node, isStatement) {
    if (tokType === _name) node.id = parseIdent();
    else if (isStatement) unexpected();
    else node.id = null;
    node.params = [];
    var first = true;
    expect(_parenL);
    while (!eat(_parenR)) {
      if (!first) expect(_comma); else first = false;
      node.params.push(parseIdent());
    }

    // Start a new scope with regard to labels and the `inFunction`
    // flag (restore them to their old value afterwards).
    var oldInFunc = inFunction, oldLabels = labels;
    inFunction = true; labels = [];
    node.body = parseBlock(true);
    inFunction = oldInFunc; labels = oldLabels;

    // If this is a strict mode function, verify that argument names
    // are not repeated, and it does not try to bind the words `eval`
    // or `arguments`.
    if (strict || node.body.body.length && isUseStrict(node.body.body[0])) {
      for (var i = node.id ? -1 : 0; i < node.params.length; ++i) {
        var id = i < 0 ? node.id : node.params[i];
        if (isStrictReservedWord(id.name) || isStrictBadIdWord(id.name))
          raise(id.start, "Defining '" + id.name + "' in strict mode");
        if (i >= 0) for (var j = 0; j < i; ++j)
          if (id.name === node.params[j].name)
            raise(id.start, "Argument name clash in strict mode");
      }
    }

    return finishNode(node, isStatement ?
                      "FunctionDeclaration" : "FunctionExpression");
  }

  // Parses a comma-separated list of expressions, and returns them as
  // an array. `close` is the token type that ends the list, and
  // `allowEmpty` can be turned on to allow subsequent commas with
  // nothing in between them to be parsed as `null` (which is needed
  // for array literals).

  function parseExprList(close, allowEmpty) {
    var elts = [], first = true;
    while (!eat(close)) {
      if (!first) {
        expect(_comma);
      } else first = false;

      if (allowEmpty && tokType === _comma) elts.push(null);
      else elts.push(parseExpression(true));
    }
    return elts;
  }

  // Parse the next token as an identifier. If `liberal` is true (used
  // when parsing properties), it will also convert keywords into
  // identifiers.

  function parseIdent(liberal) {
    var node = startNode();
    node.name = tokType === _name ?
      tokVal : (liberal && tokType.keyword) || unexpected();
    next();
    return finishNode(node, "Identifier");
  }

  return mainfn;
});
// Bring plot data into Angular scope by parsing <plot-data> directive
// body.

radian.directive('plotData', ['$http', function($http)
{
  'use strict';

  // Parse JSON or CSV data.
  function parseData(datatext, format, cols, separator) {
    var d;
    var fpre = /^\s*[-+]?[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?\s*$/;
    switch (format) {
    case 'json':
      try { d = JSON.parse(datatext); }
      catch (e) { throw Error('invalid JSON data in <plot-data>'); }
      break;
    case 'csv':
      try {
        d = $.csv.toArrays(datatext.replace(/^\s*\n/g, '').split('\n')
                           .map(function(s) {
                             return s.replace(/^\s+/, '');
                           }).join('\n'),
                           { separator: separator });
        if (d.length > 0) {
          if (d[0].length != cols.length)
            throw Error('mismatch between COLS and' +
                        ' CSV data in <plot-data>');
          var tmp = { }, nums = [];
          for (var c = 0; c < cols.length; ++c) {
            tmp[cols[c]] = [];
            nums.push(d[0][c].match(fpre));
          }
          for (var i = 0; i < d.length; ++i)
            for (var c = 0; c < cols.length; ++c) {
              if (nums[c])
                tmp[cols[c]].push(parseFloat(d[i][c]));
              else
                tmp[cols[c]].push(d[i][c]);
            }
          d = tmp;
        }
      } catch (e) { throw Error('invalid CSV data in <plot-data>'); }
    }
    return d;
  };

  // Date field processing.
  function dateProcess(d, k, f) {
    function go(x, active) {
      if (x instanceof Array && x.length > 0) {
        if (typeof x[0] == 'string' && active)
          x.forEach(function(v, i) { x[i] = f(v); });
        else
          x.forEach(function(v) { go(v, false); });
      } else if (typeof x == 'object')
        Object.keys(x).forEach(function(xk) { go(x[xk], xk == k); });
    }
    go(d, false);
  };

  // Process all date fields.
  function processDates(scope, dataset, d) {
    if (scope.$parent[dataset] && scope.$parent[dataset].metadata) {
      for (var k in scope.$parent[dataset].metadata) {
        var md = scope.$parent[dataset].metadata[k];
        if (md.format == 'date') {
          if (!md.dateParseFormat)
            dateProcess(d, k, function(v) { return new Date(v); });
          else {
            var parse;
            if (md.dateParseFormat == 'isodate')
              parse = d3.time.format.iso.parse;
            else
              parse = d3.time.format(md.dateParseFormat).parse;
            dateProcess(d, k, function(v) { return parse(v); });
          }
        }
      }
    }
  };


  // We use a post-link function here so that any enclosed <metadata>
  // directives will have been linked by the time we get here.
  function postLink(scope, elm, as) {
    // The <plot-data> element is only there to carry data, so hide
    // it right away.
    elm.hide();

    // Process attributes.
    if (!as.name) throw Error('<plot-data> must have NAME attribute');
    var dataset = as.name;
    var format = as.format || 'json';
    var sep = as.separator === '' ? ' ' : (as.separator || ',');
    var cols = as.cols;
    if (cols) cols = cols.split(',').map(function (s) { return s.trim(); });
    var formats = ['json', 'csv'];
    if (formats.indexOf(format) == -1)
      throw Error('invalid FORMAT "' + format + '" in <plot-data>');
    if (format == 'csv' && !cols)
      throw Error('CSV <plot-data> must have COLS');
    var src = as.src;

    // Process content -- all text children are appended together
    // for parsing.
    function processData(datatext) {
      // Parse data.
      var d = parseData(datatext, format, cols, sep);

      // Process any date fields.
      processDates(scope, dataset, d);

      // Install data in scope, preserving any metadata.
      var md = scope.$parent[dataset] ? scope.$parent[dataset].metadata : null;
      scope.$parent[dataset] = d;
      if (md) scope.$parent[dataset].metadata = md;
    };
    if (!src) {
      var datatext = '';
      elm.contents().each(function(i,n) {
        if (n instanceof Text) datatext += n.textContent;
      });
      processData(datatext);
    } else {
      $http.get(src)
        .success(function(data) { processData(data); })
        .error(function() { throw Error("failed to read data from " + src); });
    }
  };

  return {
    restrict: 'E',
    scope: false,
    compile: function(elm, as, trans) {
      return { post: postLink };
    }
  };
}]);


radian.directive('metadata', [function()
{
  'use strict';

  [ 'dateFormat', 'dateParseFormat', 'errorFor',
    'format', 'label', 'units' ]

  return {
    restrict: 'E',
    scope: false,
    link: function(scope, elm, as) {
      // Identify the data set that we're metadata for.
      if (!elm[0].parentNode || elm[0].parentNode.tagName != 'PLOT-DATA' ||
          !$(elm[0].parentNode).attr('name'))
        throw Error('<metadata> not properly nested inside <plot-data>');
      var dataset = $(elm[0].parentNode).attr('name');

      // Copy metadata attributes into a new object.
      if (!as.name) throw Error('<metadata> without NAME attribute');
      var name = as.name;
      var md = { };
      [ 'dateFormat', 'dateParseFormat', 'errorFor',
        'format', 'label', 'units' ].forEach(function(a) {
          if (as.hasOwnProperty(a)) md[a] = as[a];
        });

      // Set up metadata for this data set.
      if (!scope.$parent[dataset]) scope.$parent[dataset] = { metadata: { } };
      if (!scope.$parent[dataset].metadata)
        scope.$parent[dataset].metadata = { };
      scope.$parent[dataset].metadata[name] = md;
    }
  };
}]);
// Line plots.

radian.directive('lines',
 ['plotTypeLink', function(plotTypeLink)
{
  'use strict';

  function draw(svg, x, xs, y, ys, s) {
    function sty(v) {
      return (v instanceof Array) ? function(d, i) { return v[i]; } : v;
    };
    var width   = s.strokeWidth || 1;
    var opacity = s.strokeOpacity || 1.0;
    var stroke = s.stroke || '#000';
    var sopts = [], str = '';
    if (typeof stroke == "string") {
      sopts = stroke.split(';');
      str = (sopts.length == 1 || !s.strokesel) ?
        sopts[0] : sopts[s.strokesel % sopts.length];
    }

    // Switch on type of stroke...
    if (typeof stroke != "string" || str.indexOf(':') == -1) {
      if (!(width instanceof Array || opacity instanceof Array ||
            stroke instanceof Array)) {
        // Normal lines; single path.
        var line = d3.svg.line()
          .x(function (d) { return xs(d[0]); })
          .y(function (d) { return ys(d[1]); });
        svg.append('path').datum(d3.zip(x, y))
          .attr('class', 'line').attr('d', line)
          .style('fill', 'none')
          .style('stroke-width', width)
          .style('stroke-opacity', opacity)
          .style('stroke', stroke);
      } else {
        // Multiple paths to deal with varying characteristics along
        // line.
        var based = d3.zip(x, y);
        var lined = d3.zip(based, based.slice(1));
        svg.selectAll('path').data(lined).enter().append('path')
          .attr('class', 'line')
          .style('stroke-width', sty(width))
          .style('stroke-opacity', sty(opacity))
          .style('stroke', sty(stroke))
          .attr('d', d3.svg.line()
                .x(function (d) { return xs(d[0]); })
                .y(function (d) { return ys(d[1]); }));
      }
    } else {
      // Special for fading stroke (temporary).
      var strokes = str.split(':');
      var interp = function(dx) { return 1 - Math.exp(-20*dx/(3*x.length)); };
      var ihsl = d3.interpolateHsl(strokes[0], strokes[1]);
      var based = d3.zip(x, y);
      var lined = d3.zip(based, based.slice(1));
      svg.selectAll('path').data(lined).enter().append('path')
        .attr('class', 'line')
        .style('stroke-width', width)
        .style('stroke-opacity', opacity)
        .style('stroke', function(d,i) { return ihsl(interp(i)); })
        .attr('d', d3.svg.line()
              .x(function (d) { return xs(d[0]); })
              .y(function (d) { return ys(d[1]); }));
    }
  };

  return {
    restrict: 'E',
    scope: true,
    link: function(scope, elm, as) {
      plotTypeLink(scope, elm, as, draw);
    }
  };
}]);


// Scatter/bubble plots.

radian.directive('points',
 ['plotTypeLink', function(plotTypeLink)
{
  'use strict';

  function draw(svg, x, xs, y, ys, s) {
    var marker = s.marker || "circle";
    var markerSize = s.markerSize || 1;
    var stroke = s.stroke || '#000';
    var strokeWidth = s.strokeWidth || 1.0;
    var strokeOpacity = s.strokeOpacity || 1.0;
    var fill = s.fill || 'none';
    var fillOpacity = s.fillOpacity || 1.0;
    var orientation = s.orientation || 0.0;

    // Plot points: plot attributes are either single values or arrays
    // of values, one per point.
    function sty(v) {
      return (v instanceof Array) ? function(d, i) { return v[i]; } : v;
    };
    var points = d3.svg.symbol().type(sty(marker)).size(sty(markerSize));
    svg.selectAll('path').data(d3.zip(x, y))
      .enter().append('path')
      .attr('transform', function(d) {
        return 'translate(' + xs(d[0]) + ',' + ys(d[1]) + ')';
      })
      .attr('d', points)
      .style('fill', sty(fill))
      .style('fill-opacity', sty(fillOpacity))
      .style('stroke-width', sty(strokeWidth))
      .style('stroke-opacity', sty(strokeOpacity))
      .style('stroke', sty(stroke));
  };

  return {
    restrict: 'E',
    scope: true,
    link: function(scope, elm, as) {
      plotTypeLink(scope, elm, as, draw);
    }
  };
}]);


// Bar charts.

radian.directive('bars',
 ['plotTypeLink', function(plotTypeLink)
{
  'use strict';

  function draw(svg, x, xs, y, ys, s, w, h) {
    var strokeWidth   = s.strokeWidth || 1;
    var strokeOpacity = s.strokeOpacity || 1.0;
    var stroke = s.stroke || '#000';
    var fillOpacity = s.fillOpacity || 1.0;
    var fill = s.fill || 'none';
    var barWidth = s.barWidth || 1.0;
    var barOffset = s.barOffset || 0.0;

    // Plot bars: plot attributes are either single values or arrays
    // of values, one per bar.
    function sty(v) {
      return (v instanceof Array) ? function(d, i) { return v[i]; } : v;
    };
    svg.selectAll('rect').data(d3.zip(x, y))
      .enter().append('rect')
      .attr('class', 'bar')
      .attr('x', function(d, i) {
        return d[0] instanceof Date ?
          xs(new Date(d[0].valueOf() -
                      s.barWidths[i] * (barWidth / 2.0 + barOffset))) :
          xs(d[0] - s.barWidths[i] * (barWidth / 2.0 + barOffset));
      })
      .attr('y', function(d, i) { return ys(d[1]); })
      .attr('width', function(d, i) {
        return d[0] instanceof Date ?
          xs(new Date(d[0].valueOf() + s.barWidths[i] * barWidth / 2.0)) -
          xs(new Date(d[0].valueOf() - s.barWidths[i] * barWidth / 2.0)) :
          xs(d[0] + s.barWidths[i] * barWidth / 2.0) -
          xs(d[0] - s.barWidths[i] * barWidth / 2.0);
      })
      .attr('height', function(d, i) { return h - ys(d[1]); })
      .style('fill', sty(fill))
      .style('fill-opacity', sty(fillOpacity))
      .style('stroke-width', sty(strokeWidth))
      .style('stroke-opacity', sty(strokeOpacity))
      .style('stroke', sty(stroke));
  };

  return {
    restrict: 'E',
    scope: true,
    link: function(scope, elm, as) {
      scope.$on('setupExtra', function() {
        scope.barWidths = scope.x.map(function(xval, i) {
          if (i == 0) return scope.x[1] - xval;
          else if (i == scope.x.length - 1)
            return xval - scope.x[scope.x.length - 2];
          else return (scope.x[i+1] - scope.x[i-1]) / 2;
        });
        scope.rangeXExtend = [scope.barWidths[0] / 2,
                              scope.barWidths[scope.x.length - 1] / 2];
      });
      plotTypeLink(scope, elm, as, draw);
    }
  };
}]);


// Area plots.

radian.directive('area',
 ['plotTypeLink', function(plotTypeLink)
{
  'use strict';

  function draw(svg, x, xs, y, ys, s, axis) {
    var opacity = s.fillOpacity || 1.0;
    var fill = s.fill || '#000';
    var yminv = axis == 1 ? 'ymin' : 'y2min';
    var ymin, ymintmp = 0;
    if (s.hasOwnProperty(yminv)) ymintmp = s[yminv];
    if (ymintmp instanceof Array)
      ymin = ymintmp;
    else {
      ymin = new Array(x.length);
      for (var i = 0; i < ymin.length; ++i) ymin[i] = Number(ymintmp);
    }

    // Switch on type of stroke...
    if (!(opacity instanceof Array || fill instanceof Array)) {
      // Normal area; single path.
      var area = d3.svg.area()
        .x(function(d) { return xs(d[0]); })
        .y0(function(d) { return ys(d[1]); })
        .y1(function(d) { return ys(d[2]); });
      svg.append('path').datum(d3.zip(x, ymin, y))
        .attr('class', 'area').attr('d', area)
        .style('fill-opacity', opacity)
        .style('fill', fill);
    } else throw Error("<area> plots require singular paint attributes")
  };

  return {
    restrict: 'E',
    scope: true,
    link: function(scope, elm, as) {
      plotTypeLink(scope, elm, as, draw);
    }
  };
}]);


// Process palette directive.

radian.directive('palette',
 ['discPalFn', 'contPalFn', function(discPalFn, contPalFn)
{
  'use strict';

  return {
    restrict: 'E',
    scope: false,
    link: function(scope, elm, attrs) {
      // The <palette> element is only there to carry data, so hide it
      // right away.
      elm.hide();

      // Process attributes.
      if (!attrs.name)
        throw Error("<palette> directive without NAME attribute");
      var name = attrs.name;
      var typ = attrs.type || 'norm';
      var interp = attrs.interp || 'hsl';
      interp = interp.toLowerCase();
      var banded = attrs.hasOwnProperty("banded");

      // Process content -- all text children are appended together
      // for parsing.
      var paltext = '';
      elm.contents().each(function(i,n) {
        if (n instanceof Text) paltext += n.textContent;
      });

      // Normalise content: line separators are equivalent to
      // semicolons.
      paltext = paltext.replace(/\n/g, ';');

      // Generate palette function.
      var fn;
      switch (typ) {
      case 'discrete':
        fn = discPalFn(paltext);
        break;
      case 'abs':
        fn = contPalFn(true, paltext, banded, interp);
        break;
      case 'norm':
        fn = contPalFn(false, paltext, banded, interp);
        break;
      default:
        throw Error("invalid <palette> type: " + typ);
      }

      // Install palette function.
      scope.$parent[name] = fn;
    }
  };
}]);


radian.factory('discPalFn', function()
{
  return function(txt) {
    // Prototype palette function for discrete palette with no keys,
    // i.e. just a list of colours.
    function protoNoKeys(n, cs, v) {
      if (v instanceof Array) {
        // For array data, we pull colours out of the palette in
        // sorted order of the keys.
        var vs = { };
        v.forEach(function(x) { vs[x] = 1; });
        var uvs = Object.keys(vs).sort();
        return v.map(function(x) { return cs[uvs.indexOf(x) % n]; });
      } else if (typeof v == "number")
        // Otherwise, the palette function argument must be numeric
        // and is just used as an index into the list of colours.
        return cs[(Math.round(v) - 1) % n];
      else throw Error("invalid operand to discrete palette function");
    };

    // Prototype palette function for discrete palette with keys.
    function protoWithKeys(cs, v) {
      // Just pull out the appropriate colour value using the key.
      return (v instanceof Array) ?
        v.map(function(x) { return cs[x]; }) : cs[v];
    };

    // Palette entries are separated by semicolons: split them and
    // trim them for further processing.
    var cs = txt.split(';').
      map(function(s) { return s.trim(); }).
      filter(function(s) { return s.length > 0; });

    // A palette with keys will have entries with a key, then a space,
    // then a colour value.
    if (cs[0].indexOf(' ') != -1) {
      // Set up the key to colour mapping and return a function based
      // on the "with keys" prototype.
      var thiscs = { };
      cs.forEach(function(x) {
        var css = x.split(' '), k = css[0].trim(), c = css[1].trim();
        thiscs[k] = c;
      });
      return function(v) { return protoWithKeys(thiscs, v); };
    } else {
      // Extract a simple colour list and return a function based
      // on the "no keys" prototype.
      var thisn = cs.length;
      var thiscs =
        '[' + cs.map(function(c) { return '"' + c + '"' }).join(',') + ']';
      return function(v) { return protoNoKeys(thisn, thiscs, v); };
    }
  };
});


radian.factory('contPalFn', function()
{
  return function(isabs, txt, band, interp) {
    // Prototype for returned function for normalised palette -- does
    // linear interpolation from data extent to [0,1] and applies
    // polylinear colour interpolation function.
    function protoNorm(cmap, v) {
      if (!(v instanceof Array))
        throw Error("normalised palettes must be applied to array arguments");
      var ext = d3.extent(v);
      var sc = d3.scale.linear().domain(ext);
      return v.map(function(x) { return cmap(sc(x)); });
    };

    // Prototype for returned function for absolute palette -- just
    // applies polylinear colour interpolation function.
    function protoAbs(cmap, v) {
      return v instanceof Array ?
        v.map(function(x) { return cmap(x); }) : cmap(v);
    };

    // Set up appropriate D3 colour interpolation factory.
    var intfac;
    if (band)
      intfac = function(a, b) { return function(t) { return a; }; };
    else switch (interp) {
    case 'rgb': intfac = d3.interpolateRgb;  break;
    case 'hcl': intfac = d3.interpolateHcl;  break;
    case 'lab': intfac = d3.interpolateLab;  break;
    default:    intfac = d3.interpolateHsl;  break;
    }

    // Palette entries are separated by semicolons: split them and
    // trim them for further processing.
    var cs = txt.split(';').
      map(function(s) { return s.trim(); }).
      filter(function(s) { return s.length > 0; });

    // For normalised palettes, each entry should have a numeric value
    // and a colour, separated by a space.
    if (!cs.every(function(c) { return c.indexOf(' ') != -1; }))
      throw Error("invalid format in <palette>");

    // Extract the segment limits and colours from the palette data.
    var lims = [], cols = [];
    cs.forEach(function(x) {
      var css = x.split(' ');
      lims.push(Number(css[0].trim()));
      cols.push(css[1].trim());
    });
    // Check for ascending limit values.
    for (var i = 1; i < lims.length; ++i)
      if (lims[i] < lims[i - 1])
        throw Error("entries out of order in <palette>");

    // Minimum and maximum segment limits (fix up top end for banded
    // palettes).
    var minl = lims[0], maxl = lims[lims.length-1];
    if (band && !isabs && maxl != 1) {
      lims.push(1);  cols.push('black');  maxl = 1;
    }
    if (!isabs && (minl != 0 || maxl != 1))
      throw Error("invalid segment limits for normalised palette");

    // Build polylinear colour interpolation scale using appropriate
    // colour interpolation factory.
    var thiscmap = d3.scale.linear().
      clamp(true).interpolate(intfac).
      domain(lims).range(cols);
    return isabs ?
      function(v) { return protoAbs(thiscmap, v); } :
      function(v) { return protoNorm(thiscmap, v); };
  };
});
// Plotting function library.

radian.factory('plotLib', function()
{
  'use strict';

  // Vectorise scalar function.
  function vect(f) {
    return function(x) {
      return (x instanceof Array) ? x.map(f) : f(x);
    };
  };

  // Vectorise binary operator.
  function vectOp(f) {
    return function(x, y) {
      var xa = x instanceof Array, ya = y instanceof Array;
      if (!xa && !ya) return f(x, y);
      var xlen = xa ? x.length : 0, ylen = ya ? y.length : 0;
      var rlen = xa && ya ? Math.min(xlen, ylen) : Math.max(xlen, ylen);
      var res = new Array(rlen);
      var ff;
      if (xa && ya) ff = function(i) { return f(x[i], y[i]); };
      else if (xa)  ff = function(i) { return f(x[i], y   ); };
      else          ff = function(i) { return f(x,    y[i]); };
      for (var i = 0; i < rlen; ++i) res[i] = ff(i);
      return res;
    }
  };

  // Construct grouping function.
  function by(f) {
    return function(x, c) {
      var cs = { }, ord = [];
      x.forEach(function(e, i) {
        if (cs[c[i]])
          cs[c[i]].push(e);
        else { ord.push(c[i]); cs[c[i]] = [e]; }
      });
      var ret = [];
      ord.forEach(function(e) { ret.push(f(cs[e])); });
      return ret;
    };
  };

  // Basic functions.
  function seq(s, e, n) { return d3.range(s, e, (e - s) / (n - 1)); };
  function seqStep(s, e, delta) { return d3.range(s, e, delta); };
  function sdev(x) {
    var m = d3.mean(x), m2 = d3.mean(x, function(a) { return a*a; });
    return Math.sqrt(m2 - m * m);
  };
  function unique(x) {
    var ret = [], check = { };
    x.forEach(function(e) { if (!check[e]) { ret.push(e); check[e] = 1; } });
    return ret;
  };

  // log(Gamma(x))
  function gammaln(x) {
    var cof = [76.18009172947146,-86.50532032941677,24.01409824083091,
               -1.231739572450155,0.001208650973866179,-0.000005395239384953];
    var ser = 1.000000000190015;
    var tmp = (x + 5.5) - (x + 0.5) * Math.log(x + 5.5);
    var ser1 = ser + sumArr(cof.map(function(c,y) { return c/(x+y+1); }));
    return (-tmp + Math.log(2.5066282746310005 * ser1 / x));
  };

  // Probability distributions.
  function normal(x, mu, sigma) {
    var c1 = 1 / (sigma * Math.sqrt(2 * Math.PI)), c2 = 2*sigma*sigma;
    return vect(function(x) { return c1 * Math.exp(-(x-mu)*(x-mu)/c2); })(x);
  };
  function lognormal(x, mu, sigma) {
    var c1 = 1 / (sigma * Math.sqrt(2 * Math.PI)), c2 = 2*sigma*sigma;
    return vect(function(x) {
      return x <= 0 ? 0 :
        c1/x * Math.exp(-(Math.log(x)-mu)*(Math.log(x)-mu)/c2);
    })(x);
  };
  function gamma(x, k, theta) {
    var c = k * Math.log(theta) + gammaln(k);
    return vect(function(x) {
      return x <= 0 ? 0 : Math.exp((k - 1) * Math.log(x) - x / theta - c);
    })(x);
  };
  function invgamma(x, alpha, beta) {
    var c = alpha * Math.log(beta) - gammaln(alpha);
    return vect(function(x) {
      return x<=0 ? 0 : Math.exp(cval - beta / x - (alpha + 1) * Math.log(x));
    })(x);
  };

  // Histogramming function.
  function histogram(xs, nbins) {
    var rng = d3.extent(xs), binwidth = (rng[1] - rng[0]) / nbins;
    var cs = [], ns = [];
    for (var i = 0; i < nbins; ++i) {
      ns.push(0);  cs.push(rng[0] + binwidth * (i + 0.5));
    }
    for (var i = 0; i < xs.length; ++i)
      ++ns[Math.min(nbins-1, Math.max
                    (0, Math.floor((xs[i] - rng[0]) / binwidth)))];
    var fs = [];
    for (var i = 0; i < nbins; ++i) fs.push(ns[i] / xs.length);
    return { centres:cs, counts:ns, freqs:fs };
  };

  // Library -- used for bringing useful names into scope for
  // plotting data access expressions.
  return { E: Math.E,
           LN10: Math.LN10,
           LN2: Math.LN2,
           LOG10E: Math.LOG10E,
           LOG2E: Math.LOG2E,
           PI: Math.PI,
           SQRT1_2: Math.SQRT1_2,
           SQRT2: Math.SQRT2,
           abs: vect(Math.abs),
           acos: vect(Math.acos),
           asin: vect(Math.asin),
           atan: vect(Math.atan),
           ceil: vect(Math.ceil),
           cos: vect(Math.cos),
           exp: vect(Math.exp),
           floor: vect(Math.floor),
           log: vect(Math.log),
           round: vect(Math.round),
           sin: vect(Math.sin),
           sqrt: vect(Math.sqrt),
           tan: vect(Math.tan),
           atan2: Math.atan2,
           pow: Math.pow,
           min: d3.min,
           max: d3.max,
           extent: d3.extent,
           sum: d3.sum,
           mean: d3.mean,
           median: d3.median,
           quantile: d3.quantile,
           zip: d3.zip,
           seq: seq,
           seqStep: seqStep,
           sdev: sdev,
           unique: unique,
           minBy: by(d3.min),
           maxBy: by(d3.max),
           sumBy: by(d3.sum),
           meanBy: by(d3.mean),
           sdevBy: by(sdev),
           normal: normal,
           lognormal: lognormal,
           gamma: gamma,
           invgamma: invgamma,
           histogram: histogram,
           rad$$neg: vect(function(a) { return -a; }),
           rad$$add: vectOp(function(a, b) { return a + b; }),
           rad$$sub: vectOp(function(a, b) { return a - b; }),
           rad$$mul: vectOp(function(a, b) { return a * b; }),
           rad$$div: vectOp(function(a, b) { return a / b; }),
           rad$$pow: vectOp(function(a, b) { return Math.pow(a, b); }),
         };
});
radian.directive('radianUi', ['$timeout', function($timeout)
{
  'use strict';

  return {
    restrict: 'E',
    scope: false,
    template:
    ['<div class="radian-ui" ng-show="uivisible">',
       '<span class="form-inline">',
         '<span ng-show="xvs">',
           '<span>{{xlab}}</span>',
           '<select ng-model="xidx" class="span1" ',
                   'ng-options="v[0] as v[1] for v in xvs">',
           '</select>',
         '</span>',
         '<span ng-show="xvs && yvs">',
           '&nbsp;&nbsp;vs&nbsp;&nbsp;',
         '</span>',
         '<span ng-show="yvs">',
           '<span>{{ylab}}</span>',
           '<select ng-model="yidx" class="span1" ',
                   'ng-options="v[0] as v[1] for v in yvs">',
           '</select>',
         '</span>',
         '<span ng-show="yvs && (swbut || swsel)">',
           '&nbsp;&nbsp;',
         '</span>',
         '<span ng-show="swbut">',
           '<span>{{swbutlab}}</span>',
           '<button class="btn" data-toggle="button" ',
                   'ng-click="strokesel=1-strokesel">',
             '{{swbut}}',
           '</button>',
         '</span>',
         '<span ng-show="swsel">',
           '<label>{{swsellab}}&nbsp;</label>',
           '<select ng-model="strokesel" .span1 ',
                   'ng-options="o[0] as o[1] for o in swsel">',
           '</select>',
         '</span>',
       '</span>',
     '</div>'].join(""),
    replace: true,
    link: function(scope, elm, as) {
      scope.uivisible = false;
      // Deal with switching between stroke types.
      if (scope.strokeSwitch !== undefined) {
        scope.uivisible = true;
        var label = scope.strokeSwitchLabel;
        var switches = scope.strokeSwitch.split(';');
        if (switches.length == 1) {
          // On/off UI.
          scope.swbut = switches[0];
          scope.swbutlab = label;
        } else {
          // Selector UI.
          scope.swsel = switches.map(function(sw, i) { return [i, sw]; });
          scope.swsellab = label;
        }
      }

      // Deal with selection of X and Y variables.
      if (scope.selectX !== undefined) {
        scope.uivisible = true;
        var xvars = scope.selectX.split(',');
        if (xvars.length > 1) {
          // Selector UI.
          scope.xidx = 0;
          scope.xvs = xvars.map(function(v, i) { return [i, v]; });
          scope.xlab = scope.selectXLabel;
          if (scope.selectX == scope.selectY)
            scope.$watch('xidx',
                         function(n, o) {
                           if (n == scope.yidx) scope.yidx = o;
                           scope.yvs = [].concat(scope.xvs);
                           scope.yvs.splice(n, 1);
                         });
        }
      }
      if (scope.selectY !== undefined) {
        scope.uivisible = true;
        var yvars = scope.selectY.split(',');
        if (yvars.length > 1) {
          // Selector UI.
          scope.yidx = 0;
          scope.yvs = yvars.map(function(v, i) { return [i, v]; });
          scope.ylab = scope.selectYLabel;
          if (scope.selectX == scope.selectY) {
            scope.yvs.splice(1);
            scope.yidx = 1;
          }
        }
      }
    }
  };
}]);

radian.factory('radianLegend', function()
{
  return function(svgelm, scope) {
    // Render interactive legend.
    var nswitch = scope.switchable.length;
    if (nswitch > 1) {
      var legendps = scope.switchable;
      var leggs = svgelm.append('g').selectAll('g')
        .data(legendps).enter().append('g');
      var legcs = leggs.append('circle').style('stroke-width', 1).attr('r', 5)
        .attr('fill', function(d,i) {
          return d.stroke.split(';')[0] || '#000';
        })
        .attr('stroke', function(d,i) {
          return d.stroke.split(';')[0] || '#000';
        });
      var clickHandler = function(d,i) {
        d.enabled = !d.enabled;
        d3.select(this).select('circle')
          .attr('fill', d.enabled ?
                (d.stroke.split(';')[0] || '#000') : '#f5f5f5');
        scope.$emit('paintChange');
      };
      leggs.on('click', clickHandler);
      var legts = leggs.append('text')
        .attr('text-anchor', 'start').attr('dy', '.32em').attr('dx', '8')
        .text(function(d,i) {
          return d.label || ('data' + i);
        });
      var widths = [];
      legts.each(function(d,i) { widths.push(d3.select(this).node().
                                             getComputedTextLength() + 10); });
      var mwidth = d3.max(widths), spacing = 15;
      var sep = mwidth + spacing;
      var len = nswitch * mwidth + (nswitch - 1) * spacing;
      leggs.attr('transform', function(d,i) {
        return 'translate(' + (scope.width - len + sep*i) + ',10)';
      });
    }
  };
});
// Depth-first traversal of Angular scopes.  Much like Angular's
// scope.$broadcast capability, but with operations at each level
// driven by the caller, rather than an event receiver.

radian.factory('dft', function() {
  'use strict';
  return function(scope, f) {
    function go(s) {
      f(s);
      for (var c = s.$$childHead; c; c = c.$$nextSibling) go(c);
    };
    go(scope);
  };
});


// More flexible depth-first traversal of Angular scopes, allowing for
// pruning and skipping of the top level.  The function f should
// return false if it doesn't want the traversal to continue into the
// current scope's children and true if it does.

radian.factory('dftEsc', function() {
  'use strict';
  return function(scope, f, dotop) {
    function go(s, doit) {
      if (doit) { if (!f(s)) return; }
      for (var c = s.$$childHead; c; c = c.$$nextSibling) go(c, true);
    };
    go(scope, dotop);
  };
});
// Dump tree of Angular scopes to console: useful for making sure that
// scopes have been set up properly in complicated transclusion cases.

radian.factory('dumpScope', function()
{
  'use strict';

  var go = function(scope, indent) {
    var indentstr = "";
    for (var i = 0; i < indent; ++i)
      indentstr = indentstr.concat(" ");
    console.log(indentstr + scope.$id + ": " +
                Object.keys(scope).filter(function(k) {
                  return k.charAt(0) != "$" && k != "this";
                }));
    for (var ch = scope.$$childHead; ch; ch = ch.$$nextSibling)
      go(ch, indent + 2);
  };
  return function(scope) { go(scope, 0); };
});
