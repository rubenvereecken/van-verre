// const request = require('')
const requestP = require('request-promise')
const pRetry = require('promise-retry');
const Promise = require('bluebird');
const _ = require('lodash');
const fs = require('fs');
const csv = require('csv');
const debug = require('debug')('scrape')

function cartesianProduct() {
    return _.reduce(arguments, function(a, b) {
        return _.flatten(_.map(a, function(x) {
            return _.map(b, function(y) {
                return x.concat([y]);
            });
        }), true);
    }, [ [] ]);
};

var getLocations = () => {
  return requestP({
    uri: 'http://indicatoren.verkeerscentrum.be/vc.indicators.web.gui/verkeersvolumeIndicator/getLocations?category=1',
    json: true,
  }).catch((err) => {
    console.log(err);
  })
}

var toQS = (o) => {
  var first = true;
  var s = '';
  Object.keys(o).map((k) => {
    if (!first)
      s += '&';
    else
      first = false;
    s += k + '=' + encodeURIComponent(o[k]);
  })
  return s;
}

var parse = (o, params) => {
  var headers = o.columns.map((col) => col.header);

  return o.rows.map((row) => {
    var out = {};
    row.values.forEach((val, i) => {
      out[headers[i]] = val;
    });
    out.vehicleclass = params['voertuigklasse_id']
    out.year = params['monthStartYear']
    return out;
  })
}

var params = {
  ruimtelijke_aggregatie: 'dummy',
  dagtype_id: '8',
  dagdeel_id: '4',
  voertuigklasse_id: [6, 7, 8],
  wegcategorie_groepid: '1',
  tableType: 'month',
  yearStartYear: 2014,
  yearEndYear: 2015,
  startMonth: 1,
  endMonth: 12,
}

debug('Fetching locations')
getLocations().then((locations) => {
  locations = locations.filter((loc) => loc.roadName.match(/R[12].*?Antwerpen/))

  locationIDs = locations.map((loc) => loc.id);

  var startYears = _.range(2015, 2016);
  var endYears = startYears.map((year) => year + 1);
  var years = _.zip(startYears, endYears);

  cartParams = cartesianProduct(params.voertuigklasse_id, years);

  var allParams = cartParams.map((cartParam) => {
    var localParams = _.clone(params);
    localParams.voertuigklasse_id = cartParam[0];
    localParams.monthStartYear = cartParam[1][0];
    localParams.monthEndYear = cartParam[1][1];
    localParams.locations = locationIDs;

    return localParams;
  });

  Promise.mapSeries(allParams, (param) => {
    return pRetry((retry, i) => {
      debug(`Fetching params for year ${param.monthStartYear} (${i})`);
      return requestP({
        uri: 'http://indicatoren.verkeerscentrum.be/vc.indicators.web.gui/verkeersvolumeIndicator/tableData?' + toQS({criteria: JSON.stringify(param)}),
        json: true,
      }).catch(retry);
    }).then((res) => {
      var resultsPerPage = res.resultsPerPage;
      var rows = res.totalRowCount;
      var indices = _.range(0, rows, resultsPerPage);
      // var indices = [0];

      return Promise.mapSeries(indices, (index) => {
        return pRetry((retry, i) => {
          debug(`Fetching ${index}-${index+20}/${rows} for year ${param.monthStartYear} (attempt ${i})`);
          var requestParams = {
            criteria: JSON.stringify(param),
            resultIndex: index,
            sortColumnIndex: 0,
            sortColumnDirection: 'asc',
          };

          return requestP({
            uri: 'http://indicatoren.verkeerscentrum.be/vc.indicators.web.gui/verkeersvolumeIndicator/tableData?' + toQS(requestParams),
            json: true,
          }).catch(retry);
        })
      }).then((tables) => {
        tables = tables.map((table) => parse(table, param));
        var yearTable = [].concat.apply([], tables);
        return yearTable
      })
    });
  }).then((yearTables) => {
    yearTables = [].concat.apply([], yearTables);
    csv.stringify(yearTables, { header: true }, (err, data) => {
      fs.writeFileSync('out.csv', data);
      process.exit(0)
    })

  })
})
