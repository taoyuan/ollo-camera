"use strict";

var
    fs = require('fs')
    , util = require('util')
    , stream = require('stream')
    , path = require('path')
    , http = require('http')
    , https = require('https')
    , request = require('request')
    , async = require('async')
    , gm = require('gm')
    , moment = require('moment')
    , Periodical = require('periodical')
    ;

module.exports = Cam;

function Cam(opts, app) {

    var self = this;
    stream.call(this);

    this.writable = true;
    this.readable = true;
    this.configurable = true;

    this.V = 0;
    this.G = "0";
    this.D = 220;

    this.app = app;
    this.opts = opts || { };
    this.interval = undefined; // setInterval ref
    this.present = false;

    var previewPath = '/dev/shm/camera/';
    if (!fs.existsSync(previewPath)) {
        previewPath = path.join(app.root, 'camera');
        if (!fs.existsSync(previewPath)) {
            throw new Error('No camera directory found!');
        }
    }
    this.previewFile = path.join(previewPath, 'snapshot.jpg');

    app.on('client::up', function () {

        fs.watch(previewPath, function (event, filename) {

            if (!(filename) || filename.substr(0, 5) !== 'snapshot.jpg') {
                return;
            }
            fs.lstat(path.resolve(previewPath, filename), function (err, stats) {

                if (err) {

                    if (err.code == "ENOENT") {

                        self.log.info("Camera unplugged");
                        self.unplug();
                        return;
                    }

                    self.log.error("%s", err);
                }

                if (!self.present) {

                    self.log.info("Camera plugged in");
                    init();
                }
            });
        });

        fs.lstat(self.previewFile, function (err, stats) {

            if (err) {
                self.log.info("No camera detected");
                return;
            }

            self.log.info("Found camera");
            self.emit('register', self);
            self.plugin();

        });
    });


    function init() {

        self.log.info("Camera detected");

        self.emit('register', self);
        self.plugin();
    }
}

util.inherits(Cam, stream);

Cam.prototype.write = function write(data) {
    var self = this;
    if (this.periodical) {
        if (this.periodical.isEnded()) {
            console.debug('pre periodical is ended, then execute');
            self.execute(data);
            this.periodical = null;
        } else {
            console.debug('pre periodical is not ended, then stop');
//            this.periodical.once('end', function () {
//                console.debug('pre periodical event `end`, then execute');
//                self.execute();
//            });
            this.periodical.stop();
            self.execute(data);
        }
        this.periodical = null;
    } else {
        console.debug('no pre periodical, then execute');
        self.execute(data);
    }
};

Cam.prototype.execute = function (data) {
    var log = this.log;
    log.debug("Attempting snapshot...");

    var previewFile = this.previewFile;
    var opts = this.app.opts;
    var protocol = opts.stream.secure || opts.stream.port === 443 ? 'https' : 'http';
        var postOptions = {
            method: 'POST',
            url: util.format('%s://%s:%d/rest/v0/camera/%s/snapshot', protocol, opts.stream.host, opts.stream.port, this.guid),
            headers: {
                'Content-Type': 'multipart/x-mixed-replace; boundary=myboundary',
                'X-Ollo-Token': this.app.token
            }
        };

    var periodical = this.periodical = new Periodical({
        freq: parseInt(data) || 5,
        handler: function (stream) {
            async.waterfall([
                function (callback) {
                    fs.readFile(previewFile, callback);
                }
//                , function (data, callback) {
//                    var timestamp = moment().format('YYYY-MM-DD HH:mm:ss');
//                    gm(data, 'snapshot.jpg')
//                        .font('ArialBold')
//                        .fontSize(18)
//                        .fill("#fff")
//                        .gravity('SouthEast')
//                        .drawText(10, 10,timestamp)
//                        .toBuffer(callback)
//                }
            ], function (err, data) {
                stream.safepush("--myboundary\r\n");
                stream.safepush("Content-Type: image/jpeg\r\n");
                stream.safepush("Content-Length: " + data.length + "\r\n");
                stream.safepush("\r\n");
                stream.safepush(data, 'binary');
                stream.safepush("\r\n");
            });
        }
    });

    var post = request(postOptions, function callback(err, res, body) {
        if (err) {
            return log.error('Upload failed:', err);
        }
        if (body == 'Unauthorized') {
            return log.error('Upload failed:', body);
        }
        try {
            var data = JSON.parse(body);
            if (data.result) {
                return log.debug('Snapshot upload end!');
            }
        } catch (e) {
            // no-op
        }
        log.debug('Snapshot upload ended abnormally with response:', body);
    });

    periodical.pipe(post);
};

Cam.prototype.stop = function stop() {
    if (this.intervalid) {
        clearInterval(this.intervalid);
        this.intervalid = null;
    }
};

Cam.prototype.heartbeat = function heartbeat(bool) {

    clearInterval(this.interval);

    if (!!bool) {

        var
            self = this
            , ival = this.opts.interval || 10000
            ;
        this.log.debug(
            "Setting data interval to %s"
            , Math.round(ival / 1000)
        );

        this.emit('data', '1');
        this.interval = setInterval(function () {

            self.emit('data', '1');

        }, ival);
        return;
    }
    this.log.debug("Clearing data interval");
};

Cam.prototype.unplug = function unplug() {

    this.present = false;
    this.heartbeat(false);
    this.emit('config', {

        G: this.G, V: this.V, D: this.D, type: 'UNPLUG'
    });
};

Cam.prototype.plugin = function plugin() {

    this.present = true;
    this.heartbeat(true);
    this.emit('data', '1');
    this.emit('config', {

        G: this.G, V: this.V, D: this.D, type: 'PLUGIN'
    });
};

Cam.prototype.config = function config(opts) {

    // we can do something with config opts here

    this.save(opts);
};

