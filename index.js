// Require necessary packages/files:
require('dotenv').config();
var express = require('express');
var bodyParser = require('body-parser');
var CryptoJS = require("crypto-js");
var crypto = require("crypto");
var nodemailer = require('nodemailer');
var path = require('path');
var session = require('express-session');

var mysql = require('./dbcon.js');
var AuthService = require('./auth-service.js');
var { PORT, APP_SECRET, CRYPTO_SECRET } = require('./config.js');

// Set up the server:
var app = express();

app.use(session({
  secret: APP_SECRET,
  resave: true,
  saveUninitialized: true
}));
app.use(bodyParser.urlencoded({extended:true}));
app.set('view engine', 'handlebars');
app.set('port', PORT);

var handlebars = require('express-handlebars').create({
  helpers: {
    trimString: function(stringName) {
      var newString = stringName.substring(0,1);
      return newString.toUpperCase();
    },
    ifCond: function(v1, operator, v2, options) {
      switch (operator) {
          case '==':
              return (v1 == v2) ? options.fn(this) : options.inverse(this);
          case '===':
              return (v1 === v2) ? options.fn(this) : options.inverse(this);
          case '!=':
              return (v1 != v2) ? options.fn(this) : options.inverse(this);
          case '!==':
              return (v1 !== v2) ? options.fn(this) : options.inverse(this);
          case '<':
              return (v1 < v2) ? options.fn(this) : options.inverse(this);
          case '<=':
              return (v1 <= v2) ? options.fn(this) : options.inverse(this);
          case '>':
              return (v1 > v2) ? options.fn(this) : options.inverse(this);
          case '>=':
              return (v1 >= v2) ? options.fn(this) : options.inverse(this);
          case '&&':
              return (v1 && v2) ? options.fn(this) : options.inverse(this);
          case '||':
              return (v1 || v2) ? options.fn(this) : options.inverse(this);
          default:
              return options.inverse(this);
      }
    },
  },
  defaultLayout:'main'
});

app.engine('handlebars', handlebars.engine);

// Set up routes:

app.use(express.static(path.join(__dirname, '/public')));

app.use('/auth', require('./auth-router.js'));

app.use('/projects', require('./projects.js'));

app.use('/profile', require('./profile.js'));

app.use('/project', require('./project.js'));

app.use('/task', require('./task.js'));

app.use('/mytasks', require('./myTasks.js'));

app.use('/theirTasks', require('./theirTasks.js'));

app.get('/', function(req, res, next) {
  var context = {};
  res.render('signup', context);
});

app.get('/login', function(req, res, next) {
  const context = { email: '', password: '', fromUrl: req.query.fromUrl };
  res.render('login', context);
});

app.get('/forgot', function(req, res, next) {
  const context = { email: ''};
  res.render('forgot', context);
});

/**
 * A function for getting user token
 * @param {object} res - The res object represents the HTTP response that an Express app sends when it gets an HTTP request.
 * @param {object} user - the user for whom we are getting the token
 * @param {function} complete - complete function
 * @return {void} Nothing
 */

function getToken(res, user, complete) {
  crypto.randomBytes(20, function(err, buf) {
    var token = buf.toString('hex');
    user.resetPasswordToken = token;
    complete();
  });
}

/**
 * A function that queries the mysql user table to see if a user exists.
 * @param {string} email - user email address
 * @param {object} res - The res object represents the HTTP response that an Express app sends when it gets an HTTP request.
 * @param {object} user - the user for whom we are getting the token
 * @param {function} complete - complete function
 * @return {void} Nothing
 */

function checkIfUserExists(email, res, user, complete) {
  mysql.pool.query(
    "SELECT id from users where email=" + mysql.pool.escape(email),
    function(err, result) {
      // if error, handle by outputting issue encountered
      if (err) {
        console.log(JSON.stringify(err));
        res.write(JSON.stringify(err));
        res.end();
      }
      // if id exists in the db, user already exists, don't proceed with sign up
      else if (!result[0] || !result[0].id) {
        console.log("Doesnt exist")
        res.render('forgot', {
          errors: 'Email address doesn\'t exist.',
        });
      }
      else {
        user.email = email;
        user.id = result[0].id;
        user.resetPasswordExpires = Date.now() + 3600000; // 1 hour
        complete();
      }
    })
}

/**
 * A function that updates the user token in the mysql user table.
 * @param {object} res - The res object represents the HTTP response that an Express app sends when it gets an HTTP request.
 * @param {object} user - the user for whom we are getting the token
 * @param {function} complete - complete function
 * @return {void} Nothing
 */

function updateUserTokens(res, user, complete) {
  var sql = "UPDATE users SET token = ?, tokenExpiration = ? WHERE id = ?";
  var inserts = [user.resetPasswordToken, user.resetPasswordExpires, user.id];
  sql = mysql.pool.query(sql, inserts, function(error, results, fields){
      if(error){
          res.write(JSON.stringify(error));
          res.status(400);
          res.end();
      }
      complete();
  })
}

/**
 * A function that queries the mysql user table to see if a user exists.
 * @param {object} user - the user for whom we are getting the token
 * @param {string} requestUrl - string for request URL
 * @param {function} complete - complete function
 * @return {void} Nothing
 */

function sendPasswordReset(user, requestUrl, complete) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: 'cs361osu@gmail.com',
      pass: 'superlongstringtest123'
    }
  });

  const mailOptions = {
    from: 'admin@ec3taskmanagement.com',
    to: user.email,
    subject: 'Password Reset Requested',
    text: 'You are receiving this because you (or someone else) have requested the reset of the password for your account.\n\n' +
    'Please click on the following link, or paste this into your browser to complete the process:\n\n' +
    'http://' + requestUrl + '/reset/' + user.resetPasswordToken + '\n\n' +
    'If you did not request this, please ignore this email and your password will remain unchanged.\n'
  };

  transporter.sendMail(mailOptions, function(error, info) {
    if (error) {
    console.log(error);
    } else {
      console.log('Email sent: ' + info.response);
      complete();
    }
  });
}


/** POST request that is called when user submits the password reset form */
app.post('/pass/reset', function(req, res, next) {
  var callbackCount = 0;
  var user = {};

  var requestUrl = req.headers.host;

  getToken(res, user, complete); // Create a token that is a random string

  function complete(){
      callbackCount++;
      if(callbackCount == 1){
        checkIfUserExists(req.body.user_email, res, user, complete); // see if user exists before going farther
      } else if (callbackCount == 2) {
        updateUserTokens(res, user, complete); // update the users table with the token and expiration time
      } else if (callbackCount == 3) {
        sendPasswordReset(user, requestUrl, complete); // send the password reset email using nodemailer
      } else if (callbackCount == 4) {
        // render the forgot page with a confirmation email for the user
          res.render('forgot', {
            info: 'An e-mail has been sent to ' + user.email + ' with further instructions.',
            link: 'http://' + requestUrl + '/login'
          });
      }
  }
});

/**  Reset page rendered with errors or form to create new password */
app.get('/reset/:token', function(req, res) {
  // first check if the token exists in the users table
  var sql = "SELECT id, tokenExpiration from users WHERE token = ?";
  var inserts = [req.params.token];
  sql = mysql.pool.query(sql, inserts, function(error, result, fields){
      if(error){
          res.write(JSON.stringify(error));
          res.status(400);
          res.end();
      }
      // if reset token doesn't exist, render error on page.
      // don't give access to the form.
      else if (!result[0] || !result[0].id) {
        res.render('reset', {
          errors: 'Password reset token is invalid.',
          link: 'http://' + req.headers.host + '/forgot'
        });
      }
      // check if the token is expired, currently set to 1 hour
      else if (Date.now() > result[0].tokenExpiration) {
          res.render('reset', {
            errors: 'Password reset token is expired.',
            link: 'http://' + req.headers.host + '/forgot'
          });
      }
      // otherwise, safe to show the update password form to the user.
      // valid token was supplied and token not yet expired.
      else {
        var context = {
          id: result[0].id,
          token: Date.now(),
          showForm: true
        };
        res.render('reset', context)
      }
  })
});


/** POST request that is called when user has changes their password */
app.post('/reset-password', function(req, res, next) {
  // convert the plaintext password string to encrypted hash password with CryptoJS
  var ciphertext = CryptoJS.AES.encrypt(req.body.password, CRYPTO_SECRET).toString();

  // update the users table with the new password and force the token to expire so no longer valid URL
  var sql = "UPDATE users SET password = ?, tokenExpiration = ? WHERE id = ?";
  var inserts = [ciphertext, req.body.token, req.body.id];

  sql = mysql.pool.query(sql, inserts, function(error, result, fields){
      if(error){
          res.write(JSON.stringify(error));
          res.status(400);
          res.end();
      }

      res.render('reset', {
        info: 'Password reset successfully.',
        link: 'http://' + req.headers.host + '/login'
      });
    })
});

/** Creates new user when sign up form is submitted, after validation steps */
app.post('/add-new-user', function(req, res) {
  mysql.pool.query(
    "SELECT id from users where email=" + mysql.pool.escape(req.body.user_email),
    function(err, result) {
      // if error, handle by outputting issue encountered
      if (err) {
        console.log(JSON.stringify(err));
        res.write(JSON.stringify(err));
        res.end();
      }
      // if id exists in the db, user already exists, don't proceed with sign up
      else if (result[0] && result[0].id) {
        res.render('signup', {
          errors: 'Email address already exists. Please login to your existing account or use a different email.',
        });
      }
      // we have a new user password we need to hash then add to the db
      else {
        var ciphertext = CryptoJS.AES.encrypt(req.body.user_password, CRYPTO_SECRET).toString();
        // console.log(ciphertext);
        mysql.pool.query(
          "INSERT INTO users (name, email, password) VALUES (?,?,?)",
          [req.body.full_name, req.body.user_email, ciphertext],
          function(err, result) {
            if (err) {
              console.log(JSON.stringify(err));
              res.write(JSON.stringify(err));
              res.end();
            } else {
              const payload = { userId: result.insertId };
              // store auth token in session
              req.session.authToken = AuthService.createJwt(payload);
              res.redirect('/projects');
            }
          }
        );
      }
    }
  );
});

/** Generic 404 handlebars render */
app.use(function(req,res){
  res.status(404);
  res.render('404');
});

/** Generic 500 handlebars render */
app.use(function(err, req, res, next){
  console.error(err.stack);
  res.status(500);
  res.render('500');
});

/** Start the server: */
app.listen(app.get('port'), function(){
  console.log('Express started on http://localhost:' + app.get('port') + '; press Ctrl-C to terminate.');
});
