/*
 * Cloud code for "nemp-nsw-dev" connected to the "nemp_dev_nsw" MongoLab DB deployed on Heroku
 * Git repo: 				https://github.com/grassland-curing-cfa/NempParseServerNSW
 * Initial checkin date: 	23/02/2016
 * Following-up check date:	13/07/2016
							18/07/2016
							21/07/2016
							25/07/2016: added "sendEmailRequestForValidation" function
							26/08/2016: added use of "turf" package for spatial analysis and manipulation tools;
										      updated "getPrevSimpleObsSharedInfoForState" & "getSharedPrevCuringForStateForInputToVISCA"
							21/11/2016: NEMP-1-150: added request.user to beforeSave and afterSave triggers for GCUR_OBSERVATION & GCUR_LOCATION classes
              				01/12/2016: NEMP-1-154: Running the "applyValidationByException" Cloud function creates incorrect String on the "SharedBy" column of the GCUR_OBSERVATION table
              							NEMP-1-151: Remove unnecessary Parse.User.logIn(SUPERUSER, SUPERPASSWORD) and Parse.Cloud.useMasterKey() in the Cloud function
              				11/07/2018: Created two cloud functions: "automateRunModel" & "automateFinaliseData" on the Parse Server for automating RunModel and FinaliseData jobs
							13/11/2018: Updated the getDataReport function to allow exporting current observations at any point of time
							30/06/2020: Started to upgrade all Cloud functions to Parse-server 3+.
							10/08/2020: Finished upgrading all Cloud functions to Parse-server 3+.
 */

var _ = require('underscore');
var turf = require('turf');							// https://www.npmjs.com/package/turf
const { Error } = require('parse');

//var SUPERUSER = process.env.SUPER_USER;
//var SUPERPASSWORD = process.env.SUPER_USER_PASS;
var NULL_VAL_INT = -1;
//var NULL_VAL_DBL = -1.0;
 
var APP_ID = process.env.APP_ID;
var MASTER_KEY = process.env.MASTER_KEY;
var SERVER_URL = process.env.SERVER_URL;
 
var MG_DOMAIN = process.env.MG_DOMAIN;
var MG_KEY = process.env.MG_KEY;
var CFA_NEMP_EMAIL = process.env.EMAIL_ADDR_CFA_NEMP;
var CFA_GL_EMAIL = process.env.EMAIL_ADDR_CFA_GL;
var RFS_FBA = process.env.EMAIL_ADDR_RFS_FBA;
var CFA_GL_TEAM_EMAIL = 'grassland-team@cfa.vic.gov.au';
var _IS_DAYLIGHT_SAVING = (process.env.IS_DAYLIGHT_SAVING == "1" ? true : false);     		// boolean indicates if it is now in Daylight Saving time
var _IS_FIRE_DANGER_PERIOD = (process.env.IS_FIRE_DANGER_PERIOD == "1" ? true : false);     	// boolean indicates if it is now in the Fire Danger Period
var GAE_APP_URL = process.env.GAE_APP_URL;			// The URL to the GAE app (appspot)
var _MAX_DAYS_ALLOWED_FOR_PREVIOUS_OBS = process.env.MAX_DAYS_ALLOWED_FOR_PREVIOUS_OBS;		// An obs with the FinalisedDate older than this number should not be returned and treated as Last Season data

var RESOLUTIONS = ["500", "6000"];
var SUPERUSER_OBJECTID = "AucN1rSA60";
 
// Use Parse.Cloud.define to define as many cloud functions as you want.
// For example:
Parse.Cloud.define("hello", (request) => {
	return Promise.resolve("Hello world from  " + process.env.APP_NAME);
});
 
Parse.Cloud.define("getDateInAEST", (request) => {
    var currentDateInAEST = getTodayString(_IS_DAYLIGHT_SAVING);
    return "_IS_DAYLIGHT_SAVING is " + _IS_DAYLIGHT_SAVING + "; Current Date in AEST: '" + currentDateInAEST + "'";
});

Parse.Cloud.define("testMailgunJS", async (request) => {
  var mailgun = require('mailgun-js')({apiKey: MG_KEY, domain: MG_DOMAIN});
  var data = {
    from: 'Excited User <me@samples.mailgun.org>',
    to: 'a.chen@cfa.vic.gov.au',
    bcc: 'tttchen2004@yahoo.com',
    subject: 'Hello from ' + process.env.SERVER_URL,
    text: '',
    html: 'Testing some Mailgun awesomness from <br><h1>' + process.env.SERVER_URL + '</h1>'
  };
  const sentFeedback = await mailgun.messages().send(data);
  return sentFeedback;
});

// Parse.com Job for sending Request for Validation email
/******
Period other than daylight saving days: 11.00 pm (GMT) Wed - this is equivalent to Thursday 9.00 am (AEST, GMT+10);
For Daylight Saving, 10.00 pm (GMT) = 9.00 am (GMT+11)
******/
var validationRequestEmailHtml = '<!DOCTYPE html><html>' + 
			'<head>' + 
			'<title>Request For Validation</title>' + 
			'<style>' + 
			'p, li {margin:0cm; margin-bottom:.0001pt; font-size:11.0pt; font-family:"Calibri","sans-serif";}' + 
			'</style>' + 
			'</head>' + 
			'<body>' + 
			'<p>Good morning ' + process.env.VALIDATION_NOTIF_TO_PERSON + ',</p>' + 
			'<br>' + 
			'<p>Grassland curing data for NSW is now ready for checking. To validate the ground observations, please log onto ' + process.env.APP_NAME + ' ' + 
			'<a href="' + GAE_APP_URL + '">' + GAE_APP_URL + '</a>.</p>' + 
			'<br>' + 
			'<p>The Grassland Curing Online System has been developed as part of the ongoing project goals of an easy-to-use, user-friendly, reliable and automated system. To use the system:</p>' + 
			'<br>' + 
			'<ul>' + 
			'<li>Log in with the username and password provided to you (Please make sure you use Internet Explorer 9 or above, Firefox or Google Chrome)</li>' + 
			'<li>Make sure you are with the "Validators" role. You may need to select it from the drop-down list on the top right if you have multiple roles assigned.</li>' + 
			'<li>Click "Validate Observations"</li>' + 
			'<li>Amend the curing value using the drop-down list for each location</li>' + 
			'<li>Click the "Back" button on the top to go back</li>' + 
			'<li>Log out</li>' + 
			'</ul>' + 
			'<br>' + 
			'<p>You can always reach the full system help by clicking the "Help" button on the bottom.</p>' + 
			'<br>' + 
			'<p>If you have any questions, please contact us (Susan - 03 8822 8059; Danni - 03 8822 8073; Alex - 03 8822 8060; Rachel - 03 9262 8607).</p>' + 
			'<br>' + 
			'<p>Kind Regards,</p>' + 
			'<br>' + 
			'<p>The NEMP Grassland Curing Team</p>' + 
			'<br>' + 
			'<table><tr><td width="30%"><img src="http://www.cfa.vic.gov.au/img/logo.png" width="64" height="64" alt="CFA_LOGO" /></td>' + 
			'<td><p style="color:#C00000; font-weight: bold;">NEMP Grassland Curing Team</p><p>CFA HQ - Fire & Emergency Management - 8 Lakeside Drive, Burwood East, Victoria, 3151</p>' + 
			'<p>E: <a href="mailto:' + CFA_NEMP_EMAIL + '" target="_top">' + CFA_NEMP_EMAIL + '</a></p></td></tr></table>' + 
			'<br>' + 
			'<p><i>Note: This email has been generated automatically by ' + process.env.APP_NAME + '.</i></p>' + 
			'</body>' + 
			'</html>';

Parse.Cloud.define("sendEmailRequestForValidation", (request) => {
	console.log('Function [sendEmailRequestForValidation] being executed...');

	if (_IS_FIRE_DANGER_PERIOD) {
		var toEmails = process.env.VALIDATION_NOTIF_TO_EMAILS;

		var mailgun = require('mailgun-js')({apiKey: MG_KEY, domain: MG_DOMAIN});

		var data = {
			to: toEmails,
			cc: CFA_NEMP_EMAIL,
			from: CFA_NEMP_EMAIL,
			subject: "Grassland Curing Validation Notification",
			text: "",
			html: validationRequestEmailHtml
		};

		return mailgun.messages().send(data, function (error, body) {
			if (error) {
				console.log(error);
				throw new Error("" + error);
			}
			else {
				console.log(body);
				return "" + body;
			}
		});
	}
	else
		return Promise.resolve("_IS_FIRE_DANGER_PERIOD: " + _IS_FIRE_DANGER_PERIOD + "; No RequestForValidation email to be sent.");
});
 
// Send a "Want to become an observer" email via Mailgun
Parse.Cloud.define("sendEmailWantToBecomeObserver", async (request) => {
    const mailgun = require('mailgun-js')({apiKey: MG_KEY, domain: MG_DOMAIN});
     
    const firstname = request.params.fn;
    const lastname = request.params.ln;
    const email = request.params.em;
    const address = request.params.addr;
    const suburb = request.params.sub;
    const state = request.params.st;
    const postcode = request.params.pc;
     
    // the email body HTML template to RFS staff
    const html1 = '<!DOCTYPE html><html>' +
    '<body>' + 
    'Hello RFS Fire Behaviour Analysis Team,' + 
    '<p>' + '<strong>' + firstname + ' ' +  lastname + '</strong> (<a href="mailto:' + email + '">' + email + '</a>) has shown interest to become an observer. The following contact details have also been provided on the Portal:</p>' + 
    '<ul>' + 
    '<li>Address: ' + address + '</li>' + 
    '<li>Suburb:  ' + suburb + '</li>' + 
    '<li>State:       ' + state + '</li>' + 
    '<li>Postcode:    ' + postcode + '</li>' + 
    '</ul>' +
    '<p>Also, an introductory welcoming email has been sent to <a href="mailto:' + email + '">' + email + '</a>.</p>' + 
    '<p>Kind Regards,</p>' + 
    '<p><i>Note: This email has been generated automatically by ' + process.env.APP_NAME + '.</i></p>' + 
    '</body>' + 
    '</html>';
     
    // the email body HTML template to who registered interest to become an observer
    const html2 = '<!DOCTYPE html><html>' +
    '<body>' + 
    'Welcome to ' + process.env.APP_NAME + '.' + 
    '<p>A NSW RFS member will sign you up to our online Portal. Once you have been added to the Portal, you will receive an automatic email to verify your email address before you can access the online portal.</p>' + 
    '<p>Thank you for your assistance in Grassland Fuel Reporting.</p>' + 
    '<p>NSW RFS Fire Behaviour Analysis Team</p>' + 
    '<p>NSW RURAL FIRE SERVICE</p>' + 
    '<p>Headquarters 15 Carter Street Lidcombe NSW 2141 | Locked Bag 17 Granville NSW 2142</p>' + 
    '<p><strong>P</strong> 02 8741 5254 <strong>E</strong> FireBehaviour.Analysis@rfs.nsw.gov.au</p>' + 
    '<p>www.rfs.nsw.gov.au | www.facebook.com/nswrfs | www.twitter.com/nswrfs</p>' + 
    '<p><strong>PREPARE. ACT. SURVIVE.</strong></p>' + 
    '<p><i>Note: This email has been generated automatically by ' + process.env.APP_NAME + '. Please do not reply to this email.</i></p>' + 
    '</body>' + 
    '</html>';

    const sentFeedback1 = await mailgun.messages().send({
      from: CFA_NEMP_EMAIL,
	  to: RFS_FBA,
      bcc: CFA_NEMP_EMAIL,
      subject: "Express of Interest to become a grassland curing observer",
      text: '',
      html: html1
    });

    const sentFeedback2 = await mailgun.messages().send({
      from: RFS_FBA,
      to: email,
      bcc: CFA_NEMP_EMAIL,
      subject: "Welcome to " + process.env.APP_NAME,
      text: '',
      html: html2
	});
	
	return JSON.stringify(sentFeedback1) + ". " + JSON.stringify(sentFeedback2);
});
 
//Send a "Welcome email to new user upon signed-up" via Mailgun
Parse.Cloud.define("sendEmailWelcomeNewUser", (request) => {
    var mailgun = require('mailgun-js')({apiKey: MG_KEY, domain: MG_DOMAIN});
     
    var firstname = request.params.fn;
    var lastname = request.params.ln;
    var username = request.params.un;
    var password = request.params.pw;
    var email = request.params.em;
     
    var html = '<!DOCTYPE html><html>' +
			    '<head>' + 
			    '<meta charset="UTF-8">' + 
			    '<title>Welcome to the NEMP Grassland Curing Trial</title>' + 
			    '<style>' + 
			    'p, li {margin:0cm; margin-bottom:.0001pt; font-size:11.0pt; font-family:"Calibri","sans-serif";}' + 
			    '</style>' + 
			    '</head>' + 
			    '<body>' + 
			    '<p>Hi ' + firstname + ',' + '</p>' + '<br>' + 
			    '<p>Thank you for participating in the New South Wales grassland curing trial. This trial is supported in collaboration with the NSW Rural Fire Services (RFS) and is sponsored by the Commonwealth Attorney General&#39;s Department National Emergency Management Projects (NEMP).</p>' + '<br>' + 
			    '<p>Currently in Victoria, grassland curing is monitored operationally using a combination of satellite data and field observations, which are reported weekly by observers using a web-based data entry tool. As a trial, we are deploying the Victorian approach for New South Wales (as well as other states and territories). For online training videos, we encourage you to visit <a href="www.cfa.vic.gov.au/grass">www.cfa.vic.gov.au/grass</a>.</p>' + '<br>' + 
			    '<p>The New South Wales web-based data entry tool can be accessed via: <a href="' + GAE_APP_URL + '">' + GAE_APP_URL + '</a> (take note, the tool works best on Firefox, Chrome, Internet Explorer 9 or 10)</p>' + '<br>' + 
			    '<p>Your login details are as follows: </p>' + '<br>' + 
			    '<ul>' + 
			    '<li>Username: ' + username + '</li>' + 
			    '<li>Password: ' + password + '</li>' + 
			    '</ul>' + '<br>' + 
			    '<p>Once you have logged on, you can select &#34;Enter Observations&#34;, and click on your observation site. You can then enter your curing observation from the drop-down list as well as providing a height, cover and fuel load estimate. When you are finished, click &#34;Submit Observation&#34; at the bottom of the page.</p>' + '<br>' + 
			    '<p>Observations can be entered anytime during the week up until <strong>Wednesday evening at 5pm</strong>. On <strong>Thursday morning</strong>, a trial curing map will be published and sent to all observers via email. We hope to continue this process on a weekly basis for the duration of the fire season.</p>' + '<br>' + 
			    '<p>Once again, we thank you for your interest. Please contact us, the NSW RFS Fire Behaviour Analysis Team <a href="mailto:' + RFS_FBA + '">' + RFS_FBA + '</a> if you have any questions. We look forward to hearing from you soon.</p>' + '<br>' + 
			    '<p>Kind Regards,</p>' + 
			    '<p>The NEMP Grassland Curing Team</p>' + 
			    '<br>' + 
			    '<table><tr><td width="30%"><img src="http://www.cfa.vic.gov.au/img/logo.png" width="64" height="64" alt="CFA_LOGO" /></td>' + 
			    '<td><p style="color:#C00000; font-weight: bold;">NEMP Grassland Curing Team</p><p>CFA HQ - Fire & Emergency Management - 8 Lakeside Drive, Burwood East, Victoria, 3151</p>' + 
			    '<p>E: <a href="mailto:' + CFA_NEMP_EMAIL + '" target="_top">' + CFA_NEMP_EMAIL + '</a></p></td></tr></table>' + 
			    '<br>' + 
			    '<p><i>Note: This email has been generated automatically by ' + process.env.APP_NAME + '. Please do not reply to this email.</i></p>' + 
			    '</body>' + 
			    '</html>';

    return mailgun.messages().send({
      from: CFA_NEMP_EMAIL,
      to: email,
      bcc: CFA_NEMP_EMAIL,
      subject: "Welcome to the NSW Grassland Curing Trial",
      text: '',
      html: html
    }, function (error, body) {
      if (error)
        throw new Error("" + error);    
      else
        return JSON.stringify(body);
    });
})
 
//Send an email via Mailgun with finalised curing map to FBA
Parse.Cloud.define("sendEmailFinalisedDataToObservers", async (request) => {
	/*
    // get all active observers
    let recipientList = "";
     
    const queryMMR = new Parse.Query("GCUR_MMR_USER_ROLE");
    queryMMR.include("user");
    queryMMR.include("role");
    queryMMR.limit(1000);
    const results = await queryMMR.find({ useMasterKey: true });
        // results is array of GCUR_MMR_USER_ROLE records
	
	for (let i = 0; i < results.length; i++) {
        const role = results[i].get("role");
        const status = results[i].get("status");
        if (status && (role.get("name") == "Observers")) {
            const user = results[i].get("user");
			const email = user.get("email");
			console.log("*** " + email);
            recipientList = recipientList + email + ";";
        }
	}
	*/
         
	// use Mailgun to send email
	try {
		const mailgun = require('mailgun-js')({apiKey: MG_KEY, domain: MG_DOMAIN});
			
		const strToday = getTodayString(_IS_DAYLIGHT_SAVING);
			
		const html = '<!DOCTYPE html><html>' +
			'<body>' + 
			'Hello all,' + 
			'<p>The NSW grassland curing map has been updated for the ' + strToday + '. To view the map, please click <a href="' + GAE_APP_URL + '/viscaModel?action=grasslandCuringMap">here</a>.</p>' + 
			'<p>Kind Regards,</p>' + 
			'<p>NSW RFS Fire Behaviour Analysis Team <a href="' + RFS_FBA + '">' + RFS_FBA + '</a></p>' + 
			'<p><i>Note: This email has been generated automatically by ' + process.env.APP_NAME + '. Please do not reply to this email.</i></p>' + 
			'</body>' + 
			'</html>';

		const sentFeedback = await mailgun.messages().send({
			from: RFS_FBA,
			to: RFS_FBA + ";" + process.env.ADDITIONAL_EMAILS_FOR_FINALISED_MAP,
			//to: "a.chen@cfa.vic.gov.au",
			bcc: CFA_NEMP_EMAIL + ";" + CFA_GL_EMAIL + ";" + CFA_GL_TEAM_EMAIL,
			subject: "New South Wales Grassland Curing Map - " + strToday,
			text: '',
			html: html
		});

		return sentFeedback;
	} catch (e) {
        throw 'Error in sending email via Mailgun. Details: ' + e;
    }
});

//export a list of email addresses for all active users
Parse.Cloud.define("exportEmailsForActiveUsers", (request) => {
	var recipientList = "";
	
	var queryMMR = new Parse.Query("GCUR_MMR_USER_ROLE");
	queryMMR.include("user");
	queryMMR.include("role");
	queryMMR.limit(1000);
	return queryMMR.find({ useMasterKey: true }).then(function(results) {
		// results is array of GCUR_MMR_USER_ROLE records
		for (var i = 0; i < results.length; i++) {
			var role = results[i].get("role");
			var status = results[i].get("status");
			if (status && ((role.get("name") == "Observers") || (role.get("name") == "Validators"))) {
			//if (status) {	// only select active users
				var user = results[i].get("user");
				var email = user.get("email");
				
				if (recipientList.indexOf(email) == -1) {
					console.log("Email [" + email + "] being added in recipientList.");
					recipientList = recipientList + email + ";";
				} else
					console.log("Email [" + email + "] already added in recipientList.");
			}
		}
		return recipientList;	
	}, function(error) {
	    throw new Error("GCUR_MMR_USER_ROLE table lookup failed");
	});
});

// export a list of email addresses for all activated validators and admins
Parse.Cloud.define("exportAllValAdminEmails", (request) => {
	var recipientList = "";
	
	var queryMMR = new Parse.Query("GCUR_MMR_USER_ROLE");
	queryMMR.include("user");
	queryMMR.include("role");
	queryMMR.limit(1000);
	return queryMMR.find({ useMasterKey: true }).then(function(results) {
		// results is array of GCUR_MMR_USER_ROLE records
		for (var i = 0; i < results.length; i++) {
			var role = results[i].get("role");
			var status = results[i].get("status");
			if (status && ((role.get("name") == "Administrators") || (role.get("name") == "Validators"))) {
			//if (status) {	// only select active users
				var user = results[i].get("user");
				var email = user.get("email");
				
				if (recipientList.indexOf(email) == -1) {
					console.log(role.get("name") + " - Email [" + email + "] being added in recipientList.");
					recipientList = recipientList + email + ";";
				} else
					console.log(role.get("name") + " - Email [" + email + "] already added in recipientList.");
			}
		}
		return recipientList;	
	}, function(error) {
	    throw new Error("GCUR_MMR_USER_ROLE table lookup failed");
	});
});

Parse.Cloud.define("countOfObservations", async (request) => {
	const query = new Parse.Query("GCUR_OBSERVATION");
	const countOfObs = await query.count({ useMasterKey: true });
	console.log("*** async count=" + countOfObs);
	return countOfObs;
});

Parse.Cloud.define("isLocationNameExist", async (request) => {
	const query = new Parse.Query("GCUR_LOCATION");
    query.equalTo("LocationName", request.params.locationName);
    query.limit(1000);
    const results = await query.find(); {
	
	if (results.length > 0)
    	return results[0];
    else
    	return new Object();
    }
});

/**
 * Called by SignupServlet doPost if any one of the following steps fails
 * // 1. createUser // 2. assignUserToRole
 */
Parse.Cloud.define("deleteUserByUsername", (request) => {
	var username = request.params.username;
	
	// Check if the username exists before it is deleted
	var queryUser = new Parse.Query(Parse.User);
	queryUser.equalTo("username", username);
	queryUser.limit(1000);
	return queryUser.find({ useMasterKey: true }).then(function(results) {
		console.log(results.length + " _USER found for username [" + username + "]. Ready to be destroyed by the function deleteUserByUsername!");
		return Parse.Object.destroyAll(results);
	}, function(error) {
		console.log("_USER table lookup failed");
		return false;
	}).then(function() {
		console.log('_USER record [' + username + '] successfully deleted.');
		return true;
	}, function(error) {
		console.log('Failed to delete _USER record[' + username + '].');
		return false;
	});
});

/**
 * Populate all ShareBy{STATE} columns available by "True" beforeSave a new Observation is added
 */
Parse.Cloud.beforeSave("GCUR_OBSERVATION", async (request) => {
	//console.log("*** beforeSave triggered - START");
	const objId = request.object.id;
	const loc = request.object.get("Location");
	
	if (loc != undefined) {
		let locObjId = loc.id;
		console.log("*** beforeSave triggered on GCUR_OBSERVATION for GCUR_LOCATION: " + locObjId);
	}
	
	if (request.user != undefined) {
		console.log("*** beforeSave requested by _User: " + request.user.id);
	}
	
	let newAreaCuring = newValidatorCuring = newAdminCuring = newValidatorFuelLoad = undefined;
	newAreaCuring = request.object.get("AreaCuring");
	newValidatorCuring = request.object.get("ValidatorCuring");
	newAdminCuring = request.object.get("AdminCuring");
	newValidatorFuelLoad = request.object.get("ValidatorFuelLoad");
				
	console.log("*** beforeSave: AreaCuring[ " + newAreaCuring + "], ValidatorCuring[" + newValidatorCuring + "], AdminCuring[" + newAdminCuring + "], ValidatorFuelLoad[" + newValidatorFuelLoad + "]");
	
	let sharedWithJurisArr = [];
	
	// Adding a new GCUR_OBSERVATION object
	if(request.object.isNew()) {
		//console.log("*** beforeSave: Adding a new Observation.");
		const sharedJurisSettingsQ = new Parse.Query("GCUR_SHARED_JURIS_SETTINGS");
		const sjsObjs = await sharedJurisSettingsQ.find();
		for (let i = 0; i < sjsObjs.length; i ++) {
			var jurisdiction = sjsObjs[i].get("Jurisdiction");
			sharedWithJurisArr.push(jurisdiction);
		}

		let sharedByArr = [];
			
		for (let i = 0; i < sharedWithJurisArr.length; i ++) {
			sharedByArr.push({
				"st" : sharedWithJurisArr[i],
				"sh" : true
			});
		}
			
		request.object.set("SharedBy", JSON.stringify(sharedByArr));
	}
	// Updating an existing GCUR_OBSERVATION object
	else {
		//console.log("*** beforeSave: Updating an existing Observation. GCUR_OBSERVATION objectId = " + objId);
		if ( (newAreaCuring == undefined) && (newValidatorCuring == undefined) && (newAdminCuring == undefined) && (newValidatorFuelLoad == undefined) ) {
			const queryObservation = new Parse.Query("GCUR_OBSERVATION");
			queryObservation.equalTo("objectId", objId);
			const object = await queryObservation.first();
			await object.destroy();
		}
	}
});

/*
 * after a new Observation is added
 */
Parse.Cloud.afterSave("GCUR_OBSERVATION", async (request) => {
	//console.log("*** afterSave triggered - START");
	var objId = request.object.id;
	var loc = request.object.get("Location");
	var locObjId = loc.id;
	console.log("*** afterSave triggered on GCUR_OBSERVATION [" + objId + "] for GCUR_LOCATION [" + locObjId + "]");
});

/*
 * after a new Location is added
 */
Parse.Cloud.afterSave("GCUR_LOCATION", (request) => {
	var objId = request.object.id;
	var locName = request.object.get("LocationName");

	if (request.user != undefined) {
		var queryUser = new Parse.Query(Parse.User);
		queryUser.equalTo("objectId", request.user.id);
		
		// Use the new "useMasterKey" option in the Parse Server Cloud Code to bypass ACLs or CLPs.
		return queryUser.first({ useMasterKey: true }).then(function (user) {
			var userName = user.get("username");
			console.log("*** afterSave GCUR_LOCATION [" + locName + "] [" + objId + "] requested by _User [" + userName + "] [" + request.user.id + "]");
		}, function(error) {
			console.log("*** afterSave GCUR_LOCATION [" + locName + "] [" + objId + "] requested by _User [" + request.user.id + "]");
			console.error("Parse.User table lookup failed. Error: " + error.code + " " + error.message);
		});
	} else {
		console.log("*** afterSave GCUR_LOCATION [" + locName + "] [" + objId + "]. Requesting user is undefined.");
	}
});

/**
 * Retrieve shared infos for shared locations for State
 */
Parse.Cloud.define("getPrevSimpleObsSharedInfoForState", async (request) => {
	const stateName = request.params.state;
	
	let isBufferZonePntsForStateApplied = true;
	let bufferZonePntsForState = null;
	
	let sharedInfos = [];
	
	const querySharedJurisSettings = new Parse.Query("GCUR_SHARED_JURIS_SETTINGS");
	querySharedJurisSettings.equalTo("Jurisdiction", stateName);		// Find the record for the input jurisdiction

	// Find the "bufferZonePnts" for the input jurisdiction
	// "bufferZonePnts" can be either the set point array, or "null" or "undefined" as well.
	const jurisSetting = await querySharedJurisSettings.first();
	bufferZonePntsForState = jurisSetting.get("bufferZonePnts");

	if ((bufferZonePntsForState == null) || (bufferZonePntsForState == undefined))
		isBufferZonePntsForStateApplied = false;

	console.log("isBufferZonePntsForStateApplied = " + isBufferZonePntsForStateApplied + " for " + stateName);
		
	const queryObservation = new Parse.Query("GCUR_OBSERVATION");
	queryObservation.include("Location");
	queryObservation.equalTo("ObservationStatus", 1);			// Previous week's observations
	queryObservation.limit(1000);
	const obs = await queryObservation.find();

	for (let j = 0; j < obs.length; j ++) {
		// check if FinalisedDate is 30 days away
		let isPrevObsTooOld = isObsTooOld(obs[j].get("FinalisedDate"));
		if (!isPrevObsTooOld) {
			const loc = obs[j].get("Location");
			const isShareable = loc.get("Shareable");
			const locStatus = loc.get("LocationStatus");
			
			// We only retrieve obs curing for locations that are shareable
			if ( isShareable && (locStatus.toLowerCase() != "suspended") ) {
				const locObjId = loc.id;
				const locName = loc.get("LocationName");
				const distNo = loc.get("DistrictNo");
				const locLat = loc.get("Lat");
				const locLng = loc.get("Lng");
				
				const obsObjId = obs[j].id;
				
				let prevOpsCuring = prevOpsDate = undefined;		// Either can be undefined.
				
				if (obs[j].has("AdminCuring")) {
					prevOpsCuring = obs[j].get("AdminCuring");
				} else if (obs[j].has("ValidatorCuring")) {
					prevOpsCuring = obs[j].get("ValidatorCuring");
				} else if (obs[j].has("AreaCuring")) {
					prevOpsCuring = obs[j].get("AreaCuring");
				}
				
				if (obs[j].has("AdminDate")) {
					prevOpsDate = obs[j].get("AdminDate");
				} else if (obs[j].has("ValidationDate")) {
					prevOpsDate = obs[j].get("ValidationDate");
				} else if (obs[j].has("ObservationDate")) {
					prevOpsDate = obs[j].get("ObservationDate");
				}
				
				if (prevOpsCuring == undefined) {
					console.log(locName + " [" + locObjId + "] has no prevOpsCuring, so will not proceed to the further process.");
				}

				const finalisedDate = obs[j].get("FinalisedDate");
				
				// In Array; convert raw string to JSON Array
				// For example, "[{"st":"VIC","sh":false},{"st":"QLD","sh":true},{"st":"NSW","sh":true}]"
				if (obs[j].has("SharedBy") && (prevOpsCuring != undefined)) {
					const sharedByInfo = JSON.parse(obs[j].get("SharedBy"));
					
					for (let p = 0; p < sharedByInfo.length; p ++) {
						if (sharedByInfo[p]["st"] == stateName) {
							const isSharedByState = sharedByInfo[p]["sh"];
							
							let returnedItem = {
								"obsObjId" : obsObjId,
								"locObjId"	: locObjId,
								"locName" : locName,
								"locStatus" : locStatus,
								"distNo" : distNo,
								"isSharedByState" : isSharedByState,
								"prevOpsCuring" : prevOpsCuring,
								"prevOpsDate" : prevOpsDate,
								"lat" : locLat,
								"lng" : locLng,
								"finalisedDate" : finalisedDate
							};
							
							sharedInfos.push(returnedItem);
							break;
						}
					}
				}
			}
		}
	}
	
	let returnedObj = {
		"state" : stateName,
		"sharedInfos" : sharedInfos
	};
	
	// If isBufferZonePntsForStateApplied is false OR sharedInfos contains zero element
	if ((isBufferZonePntsForStateApplied == false) || (sharedInfos.length < 1)) {
		console.log("Not to apply buffer zone for " + stateName + " OR sharedInfos contains zero element.");
	}
	// apply Turf package for buffering
	else {
		let searchWithin = {
				"type": "FeatureCollection",
				"features": [
				  {
					  "type": "Feature",
					  "properties": {},
					  "geometry": {
						"type": "Polygon",
						"coordinates": new Array()
					  }
				  }
				]
		};
		
		bufferZonePntsForState = JSON.parse(bufferZonePntsForState);
		searchWithin["features"][0]["geometry"]["coordinates"].push(bufferZonePntsForState);

		let pointsToCheck = {
				"type": "FeatureCollection",
				"features": []
		};
		
		for (let j = 0; j < sharedInfos.length; j++) {
			const obsObjId = sharedInfos[j]["obsObjId"];
			const lat = sharedInfos[j]["lat"];
			const lng = sharedInfos[j]["lng"];
			
			let featureObj = {
					"type": "Feature",
					"properties": {"obsObjId" : obsObjId},
					"geometry": {
						"type": "Point",
						"coordinates": [lng, lat]
					}
			};
			
			pointsToCheck["features"].push(featureObj);
		}
		
		// Use Turf to retrieve points that are within the buffer zone
		const ptsWithin = turf.within(pointsToCheck, searchWithin);
		
		let sharedInfosFiltered = [];
		
		console.log("Out of a total of " + sharedInfos.length + " observations, " + ptsWithin["features"].length + " are within the buffer zone of " + stateName);
		
		for (let m = 0; m < ptsWithin["features"].length; m++) {
			for (let n = 0; n < sharedInfos.length; n++) {
				if (ptsWithin["features"][m]["properties"]["obsObjId"] == sharedInfos[n]["obsObjId"]) {
					sharedInfosFiltered.push(sharedInfos[n]);
					break;
				}
			}
		}
		
		returnedObj = {
			"state" : stateName,
			"sharedInfos" : sharedInfosFiltered
		};
	}
	
	return returnedObj;
});

/**
 * Retrieve previous curing values (shared only!) for shared locations for State
 * This Cloud function is called from the VISCA model directly!
 */
Parse.Cloud.define("getSharedPrevCuringForStateForInputToVISCA", (request) => {
	var stateName = request.params.state;
	
	var isBufferZonePntsForStateApplied = true;
	var bufferZonePntsForState = null;
	
	var sharedObsArr = [];
	
	var querySharedJurisSettings = new Parse.Query("GCUR_SHARED_JURIS_SETTINGS");
	querySharedJurisSettings.equalTo("Jurisdiction", stateName);		// Find the record for the input jurisdiction

	// Find the "bufferZonePnts" for the input jurisdiction
	// "bufferZonePnts" can be either the set point array, or "null" or "undefined" as well.
	return querySharedJurisSettings.first().then(function(jurisSetting) {
		bufferZonePntsForState = jurisSetting.get("bufferZonePnts");
			
		if ((bufferZonePntsForState == null) || (bufferZonePntsForState == undefined))
			isBufferZonePntsForStateApplied = false;
			
		return Promise.resolve("'bufferZonePnts' is found for jurisdiction " + stateName);
	}, function(error) {
		console.log("There was an error in finding Class 'GCUR_SHARED_JURIS_SETTINGS', but we continue to find previous observations.");
		return Promise.resolve("There was an error in finding Class 'GCUR_SHARED_JURIS_SETTINGS', but we continue to find previous observations.");
	}).then(function() {
		console.log("isBufferZonePntsForStateApplied = " + isBufferZonePntsForStateApplied + " for " + stateName);
	
		var queryObservation = new Parse.Query("GCUR_OBSERVATION");
		queryObservation.include("Location");
		queryObservation.equalTo("ObservationStatus", 1);			// Previous week's observations
		queryObservation.limit(1000);
	
		return queryObservation.find();
	}).then(function(obs) {
		for (var j = 0; j < obs.length; j ++) {
			// check if FinalisedDate is 30 days away
			var isPrevObsTooOld = isObsTooOld(obs[j].get("FinalisedDate"));
			if (!isPrevObsTooOld) {
				var loc = obs[j].get("Location");
				var isShareable = loc.get("Shareable");
				var locStatus = loc.get("LocationStatus");
				
				// We only retrieve obs curing for locations that are shareable
				if ( isShareable && (locStatus.toLowerCase() != "suspended") ) {
					var locObjId = loc.id;
					var locName = loc.get("LocationName");
					var locLat = loc.get("Lat");
					var locLng = loc.get("Lng");
					
					var obsObjId = obs[j].id;
					
					var prevOpsCuring = undefined;
					if (obs[j].has("AdminCuring")) {
						prevOpsCuring = obs[j].get("AdminCuring");
					} else if (obs[j].has("ValidatorCuring")) {
						prevOpsCuring = obs[j].get("ValidatorCuring");
					} else if (obs[j].has("AreaCuring")) {
						prevOpsCuring = obs[j].get("AreaCuring");
					}
					
					if (prevOpsCuring == undefined) {
						console.log(locName + " [" + locObjId + "] has no prevOpsCuring, so will not proceed to the further process.");
					}
					
					// In Array; convert raw string to JSON Array
					// For example, "[{"st":"VIC","sh":false},{"st":"QLD","sh":true},{"st":"NSW","sh":true}]"
					if (obs[j].has("SharedBy") && (prevOpsCuring != undefined)) {
						
						var sharedByInfo = JSON.parse(obs[j].get("SharedBy"));
						
						//var isSharedByState;
						
						for (var p = 0; p < sharedByInfo.length; p ++) {
							if ( (sharedByInfo[p]["st"] == stateName) && (sharedByInfo[p]["sh"]) ) {
								var sharedObs = {
									"obsObjId" : obsObjId,
									"locObjId"	: locObjId,
									"locName" : locName,
									"bestCuring" : prevOpsCuring,
									"lat" : locLat,
									"lng" : locLng
								};
								
								sharedObsArr.push(sharedObs);
								break;
							}
						}
					}
				}
			}
		}
		
		// Sort by locName, case-insensitive, A-Z
		sharedObsArr.sort(sort_by('locName', false, function(a){return a.toUpperCase()}));
		
		var returnedObj = {
			"state" : stateName,
			"sharedObsArr" : sharedObsArr
		};
		
		// If isBufferZonePntsForStateApplied is false OR sharedObsArr contains zero element
		if ((isBufferZonePntsForStateApplied == false) || (sharedObsArr.length < 1)) {
			console.log("Not to apply buffer zone for " + stateName + " OR sharedObsArr contains zero element.");
		}
		// apply Turf package for buffering
		else {
			var searchWithin = {
					"type": "FeatureCollection",
					"features": [
				      {
				    	  "type": "Feature",
				    	  "properties": {},
				    	  "geometry": {
					        "type": "Polygon",
					        "coordinates": new Array()
					      }
				      }
				    ]
			};
			
			bufferZonePntsForState = JSON.parse(bufferZonePntsForState);
			searchWithin["features"][0]["geometry"]["coordinates"].push(bufferZonePntsForState);

			var pointsToCheck = {
				"type": "FeatureCollection",
				"features": []
			};
			
			for (var j = 0; j < sharedObsArr.length; j++) {
				var obsObjId = sharedObsArr[j]["obsObjId"];
				var lat = sharedObsArr[j]["lat"];
				var lng = sharedObsArr[j]["lng"];
				
				var featureObj = {
					"type": "Feature",
					"properties": {"obsObjId" : obsObjId},
					"geometry": {
					    "type": "Point",
					    "coordinates": [lng, lat]
					}
				};
				
				pointsToCheck["features"].push(featureObj);
			}
			
			// Use Turf to retrieve points that are within the buffer zone
			var ptsWithin = turf.within(pointsToCheck, searchWithin);
			
			var sharedObsArrFiltered = [];
			
			console.log("Out of a total of " + sharedObsArr.length + " observations, " + ptsWithin["features"].length + " are within the buffer zone of " + stateName);
			
			for (var m = 0; m < ptsWithin["features"].length; m++) {
				for (var n = 0; n < sharedObsArr.length; n++) {
					if (ptsWithin["features"][m]["properties"]["obsObjId"] == sharedObsArr[n]["obsObjId"]) {
						sharedObsArrFiltered.push(sharedObsArr[n]);
						break;
					}
				}
			}
			
			returnedObj = {
				"state" : stateName,
				"sharedObsArr" : sharedObsArrFiltered
			};
		}
		
		return returnedObj;
	}, function(error) {
		throw new Error("Error: " + error.code + " " + error.message);
	});
});

/**
 * Update the ShareBy info (column) in the GCUR_OBSERVATION class for sharing by the jurisdiction hosting the online system
 */
Parse.Cloud.define("updateSharedByInfo", (request) => {
	/*
	 * "{\"forState\":\"NSW\", \"sharedInfos\":[{\"obsObjId\":\"syCUGywaao\", \"sh\":true},{\":[{\"obsObjId\":\"TuhtjP9rke\", \"sh\":false},{\":[{\"obsObjId\":\"YEWf4x4oSl\", \"sh\":true}]}" 
	 */
	var forState = request.params.forState;
	var sharedInfos = request.params.sharedInfos;
	
	var obsObjIds = [];
	
	for (var i = 0; i < sharedInfos.length; i ++) {
		obsObjIds.push(sharedInfos[i]["obsObjId"]);
	}
	
	// Finds GCUR_OBSERVATION from any of objectId from the input obsObjId array
	var queryObservation = new Parse.Query("GCUR_OBSERVATION");
	queryObservation.containedIn("objectId", obsObjIds);
	queryObservation.limit(1000);
	return queryObservation.find().then(function(obs) {
		// loops through all Observation records contained in the input obs list
		for (var j = 0; j < obs.length; j ++) {
			for (var i = 0; i < sharedInfos.length; i ++) {
				if (obs[j].id == sharedInfos[i]["obsObjId"]) {
					
					// [{"st":"VIC","sh":true},{"st":"QLD","sh":true},{"st":"NSW","sh":false}]
					var oldSharedBy = JSON.parse(obs[j].get("SharedBy"));
					var newIsSharedForState = sharedInfos[i]["sh"];
					
					for (var p = 0; p < oldSharedBy.length; p ++) {
						// re-set the SharedBy array with the new "sh" boolean
						if (oldSharedBy[p]["st"] == forState) {
							oldSharedBy[p]["sh"] = newIsSharedForState;
							break;
						}
					}
					
					obs[j].set("SharedBy", JSON.stringify(oldSharedBy));
					break ;
				}
			}
		}
		return Parse.Object.saveAll(obs, { useMasterKey: true });
	}).then(function(obsList) {
		// All the objects were saved.
		console.log("Updated SharedBy column on GCUR_OBSERVATION table. Updated obs count: " + obsList.length);
		return true;  //saveAll is now finished and we can properly exit with confidence :-)
	}, function(error) {
		throw new Error("Error: " + error.code + " " + error.message);
	});
});

/**
 * Removes all associated GCUR_OBSERVATION and GCUR_MMR_OBSERVER_LOCATION records
 *  when a GCUR_LOCATION is deleted
 */
Parse.Cloud.afterDelete("GCUR_LOCATION", (request) => {
	console.log("afterDelete is called on GCUR_LOCATION");
	
	query = new Parse.Query("GCUR_OBSERVATION");
	query.equalTo("Location", request.object);
	query.limit(1000);
	return query.find().then(function(observations) {
		return Parse.Object.destroyAll(observations);
	}).then(function() {
		console.log('All associated GCUR_OBSERVATION records for the deleted GCUR_LOCATION have been deleted.');
		return Promise.resolve("Hello!");
	}, function(error) {
		console.log('Failed to delete all associated GCUR_OBSERVATION records for the deleted GCUR_LOCATION.');
		return Promise.resolve("Hello!");
	}).then(function() {
		queryMMR = new Parse.Query("GCUR_MMR_OBSERVER_LOCATION");
		queryMMR.equalTo("Location", request.object);
		queryMMR.limit(1000);
		return queryMMR.find();
	}).then(function(mmrObserversLocations) {
		return Parse.Object.destroyAll(mmrObserversLocations);
	}).then(function() {
		console.log('All associated GCUR_MMR_OBSERVER_LOCATION records for the deleted GCUR_LOCATION have been deleted.');
	}, function(error) {
		console.log('Failed to delete all associated GCUR_MMR_OBSERVER_LOCATION records for the deleted GCUR_LOCATION.');
	});
});


/**
 * Removes all associated GCUR_MMR_OBSERVER_LOCATION and GCUR_MMR_USER_ROLE records
 *  when a Parse.User row is deleted
 */
Parse.Cloud.afterDelete(Parse.User, (request) => {
	var mmrObsvrLocsCount;
	var mmrUsrRoleCount;
	query = new Parse.Query("GCUR_MMR_OBSERVER_LOCATION");
	query.equalTo("Observer", request.object);
	query.limit(1000);
	return query.find().then(function(mmr_obsvr_locs) {
		mmrObsvrLocsCount = mmr_obsvr_locs.length;
		return Parse.Object.destroyAll(mmr_obsvr_locs);
	}).then(function() {
		console.log('All associated GCUR_MMR_OBSERVER_LOCATION records for the deleted User have been deleted: ' + mmrObsvrLocsCount);
		return Promise.resolve("Hello!");
	}, function(error) {
		console.log('Failed to delete all associated GCUR_MMR_OBSERVER_LOCATION records for the deleted User.');
		return Promise.resolve("Hello!");
	}).then(function() {
		queryMMR = new Parse.Query("GCUR_MMR_USER_ROLE");
		queryMMR.equalTo("user", request.object);
		queryMMR.limit(1000);
		return queryMMR.find();
	}).then(function(mmr_user_roles) {
		mmrUsrRoleCount = mmr_user_roles.length;
		return Parse.Object.destroyAll(mmr_user_roles);
	}).then(function() {
		console.log('All associated GCUR_MMR_USER_ROLE records for the deleted User have been deleted: ' + mmrUsrRoleCount);
	}, function(error) {
		console.log('Failed to delete all associated GCUR_MMR_USER_ROLE records for the deleted User.');
	});
});

/**
 * Removes the associated file uploaded before the Run Model record is deleted
 */
Parse.Cloud.beforeDelete("GCUR_RUNMODEL", async (request) => {
  // Checks if "viscaFile" has a value
  if (request.object.has("viscaFile")) {

    const file = request.object.get("viscaFile");
    const fileName = file.name();
	console.log(fileName);
	
    const httpResponse = await Parse.Cloud.httpRequest({
		method: 'DELETE',
		url: SERVER_URL + "/files/" + fileName,
		headers: {
			"X-Parse-Application-Id": APP_ID,
			"X-Parse-Master-Key" : MASTER_KEY
		}
	});
	  
	console.log('Deleted the file associated with the RunModel job successfully.');
	return true;
  } else {
    console.log('GCUR_RUNMODEL object to be deleted does not have an associated viscaFile (File). No viscaFile to be deleted.');
    return true;
  }
});

/**
 * Removes the associated viscaMapFile uploaded before the Finalise Model record is deleted
 */
Parse.Cloud.beforeDelete("GCUR_FINALISEMODEL", async (request) => {
  // Checks if "viscaFile" has a value
  if (request.object.has("viscaMapFile")) {

    const file = request.object.get("viscaMapFile");
    const fileName = file.name();
	console.log(fileName);
	
	const httpResponse = await Parse.Cloud.httpRequest({
		method: 'DELETE',
		url: SERVER_URL + "/files/" + fileName,
		headers: {
			"X-Parse-Application-Id": APP_ID,
        	"X-Parse-Master-Key" : MASTER_KEY
	  }
	}); 

	console.log('Deleted the file associated with the GCUR_FINALISEMODEL job successfully. HttpResponse: ' + httpResponse.text);
    return true;
  } else {
    console.log('GCUR_FINALISEMODEL object to be deleted does not have an associated viscaMapFile (File). No viscaMapFile to be deleted.');
    return true;
  }
});

/**
 * Called by adminTools.jsp. action=deleteRunModelJob
 */
Parse.Cloud.define("deleteRunModelById", (request) => {
	var objectId = request.params.objectId;
	
	var queryRunModel = new Parse.Query("GCUR_RUNMODEL");
	queryRunModel.equalTo("objectId", objectId);
	queryRunModel.limit(1000);
	queryRunModel.find().then(function(results) {
		console.log(results.length + " GCUR_RUNMODEL found for objectId [" + objectId + "]. Ready to be destroyed by the function deleteRunModelById!");
		return Parse.Object.destroyAll(results);
	}, function(error) {
		console.log("GCUR_RUNMODEL table lookup failed");
	    response.success(false);
	}).then(function() {
		console.log('GCUR_RUNMODEL record [' + objectId + '] successfully deleted.');
		return true;
	}, function(error) {
		// An error occurred while deleting one or more of the objects.
		// If this is an aggregate error, then we can inspect each error
		// object individually to determine the reason why a particular
		// object was not deleted.
	    if (error.code === Parse.Error.AGGREGATE_ERROR) {
	    	for (var i = 0; i < error.errors.length; i++) {
	          console.log("Couldn't delete " + error.errors[i].object.id +
	            "due to " + error.errors[i].message);
	        }
	    } else {
	    	console.log("Delete aborted because of " + error.message);
	    }
		console.log('Failed to delete GCUR_RUNMODEL record[' + objectId + '].');
		return false;
	});
});

/**
 * Retrieve a list RunModel jobs by a list of ObjectIds
 * Called by adminTools.jsp
 * action=RefreshIncompleteRunModelJobsDetailsByAjax&objectIds=
 */
Parse.Cloud.define("getRunModelDetails", (request) => {
	var inRunModelObjList = [];
	var outRunModelDetails = [];
	
	for (var i = 0; i < request.params.runModelObjIds.length; i ++) {
		//console.log("Getting RunModel Details for ObjectId [" + request.params.runModelObjIds[i]["objectId"] + "]");
		inRunModelObjList.push(request.params.runModelObjIds[i]["objectId"]);
	}
	
	// Query GCUR_RUNMODEL class
	var queryRunModel = new Parse.Query("GCUR_RUNMODEL");
	queryRunModel.containedIn("objectId", inRunModelObjList);
	queryRunModel.include("submittedBy");	// Retrieve _USER
	queryRunModel.limit(1000);
	return queryRunModel.find({ useMasterKey: true }).then(function(results) {
		for (var j = 0; j < results.length; j ++) {
			var objectId = results[j].id;
			var createdAt = results[j].createdAt;
			var updatedAt = results[j].updatedAt;
			var jobResult = results[j].get("jobResult");
			var jobResultDetails = results[j].get("jobResultDetails");
			var status = results[j].get("status");
			var viscaFile = results[j].get("viscaFile");
			var resolution = results[j].get("resolution");
			
			var submittedBy = results[j].get("submittedBy");
	        var userObjId = submittedBy.id;
	        var firstname = submittedBy.get("firstName");
	        var lastname = submittedBy.get("lastName");
	        
	        var jobDetail = {
	        		"objectId" : objectId,
	        		"createdAt" : createdAt,
	        		"updatedAt" : updatedAt,
	        		"jobResult" : jobResult,
	        		"jobResultDetails" : jobResultDetails,
	        		"status" : status,
	        		"viscaFile" : viscaFile,
	        		"resolution" : resolution,
	        		"submittedByUserOID" : userObjId,
	        		"submittedByUserFullName" : firstname + " " + lastname
	        };
	        
	        outRunModelDetails.push(jobDetail);
		}
		return outRunModelDetails;
	}, function(error) {
		throw new Error("Error: " + error.code + " " + error.message);
	});
});

/*
 * Called when user selects to manage a role under Manage User Access
*/
Parse.Cloud.define("getAllSimpleMMRUserRoleForRole", async (request) => {
	const roleObjectId = request.params.objectId;
  
	const queryRole = new Parse.Query(Parse.Role);
  	queryRole.equalTo("objectId", roleObjectId);
	const roles = await queryRole.find();
	const roleName = roles[0].get("name");

	const queryMMR = new Parse.Query("GCUR_MMR_USER_ROLE");
	// Include the post data with each comment
	queryMMR.include("user");
	queryMMR.include("role");
	queryMMR.limit(1000);
	const results = await queryMMR.find({ useMasterKey: true });

    const userStatusList = [];
      
	for (let i = 0; i < results.length; i++) {
		const role = results[i].get("role");
        const roleObjId = role.id;
        if (roleObjId == roleObjectId) {
        	//roleName = role.get("name");
        	const user = results[i].get("user");
            const username = user.get("username");
            const firstname = user.get("firstName");
            const lastname = user.get("lastName");
            const email = user.get("email");
            const userObjId = user.id;
            const simpleUser = {
              "objectId": userObjId,
    		  "username": username,
    		  "firstName": firstname,
    		  "lastName": lastname,
    		  "email": email
    	    };
            
            const status = results[i].get("status");
            const thisMMRObjIid = results[i].id;
            
            const userStatus = {
              "simpleUser": simpleUser,
              "status": status,
              "thisMMRObjId" : thisMMRObjIid
            };

            userStatusList.push(userStatus);
        }
	  }
	  
      const userStatsusForRole = {
        "roleObjectId": roleObjectId,
        "roleName": roleName,
        "userStatusList": userStatusList
      }
	 return userStatsusForRole;
});

/**
 * Login and navigate to Home page
 */
Parse.Cloud.define("getAllSimpleMMRUserRoleForUser", async (request) => {
	const userObjectId = request.params.objectId;
	
	try {
		const queryUser = new Parse.Query(Parse.User);
		queryUser.equalTo("objectId", userObjectId);
		const user = await queryUser.first({ useMasterKey: true });
		const userName = user.get("username");
		const queryMMR = new Parse.Query("GCUR_MMR_USER_ROLE");
		queryMMR.include("user");
		queryMMR.include("role");
		queryMMR.limit(1000);
		const results = await queryMMR.find({ useMasterKey: true });

		const roleStatusList = []
			  
		for (let i = 0; i < results.length; i++) {

	        const this_user = results[i].get("user");
	        const usrObjId = this_user.id;
	        if (usrObjId == userObjectId) {
	        	const role = results[i].get("role");
	            const roleName = role.get("name");
	            const roleObjId = role.id;
	            const simpleRole = {
	              "objectId": roleObjId,
	    		  "roleName": roleName
	    	    };
	            
	            const status = results[i].get("status");
	            
	            const roleStatus = {
	              "simpleRole": simpleRole,
	              "status": status
	            };

	            roleStatusList.push(roleStatus);
	        }
		}

		const roleStatsusForUser = {
			"userObjectId": userObjectId,
			"userName": userName,
			"roleStatusList": roleStatusList
		}

		return roleStatsusForUser;
	} catch (e) {
		console.log(e);
		throw new Error("Error: " + e.code + " " + e.message);
	}
});

/**
 * Show observation list after selecting a district or selecting all districts
 */
Parse.Cloud.define("getSimpleObservationsForUser", async (request) => {
	const ALL_DISTRICT = "9999";		// If the districtNo == 9999, return all active locatons.
	
	const userObjectId = request.params.objectId;
	const userRoleName = request.params.roleName;
	const districtNo = request.params.districtNo;		// If districtNo == "ALL_DISTRICT", get all active locations.
	
	const obsList = [];	// the output array for response
	
	// if the user is of Observers role, we look into the MMR table first to fetch all Active locations associated
	if (userRoleName == "Observers") {
		
		const queryMMR = new Parse.Query("mmrResults");
		// Include the Observer and Location data with each GCUR_MMR_OBSERVER_LOCATION
		queryMMR.include("Observer");
		queryMMR.include("Location");
		queryMMR.limit(1000);
		const mmrResults = await queryMMR.find({ useMasterKey: true });
		console.log("*** mmrResults len", mmrResults.length);
		for (let i = 0; i < mmrResults.length; i ++) {
			const mmr = mmrResults[i];
			const observer = mmr.get("Observer");
			const observerObjId = observer.id;
			
			// when Observer matches the param
			if (observerObjId == userObjectId) {
				const location = mmr.get("Location");
				const locationObjId = location.id;
				const locationName = location.get("LocationName");
				const locationStatus = location.get("LocationStatus");
				const locationLat = location.get("Lat");
				const locationLng = location.get("Lng");
				const locationDistrictNo = location.get("DistrictNo");
				const locationShareable = location.get("Shareable");
					
				let obs = {};
					
				let isLocInDistrict = false;
				// If the input districtNo is 9999 which is for all districts
				if (districtNo == ALL_DISTRICT)
					isLocInDistrict = true;
				else if (locationDistrictNo == districtNo)
					isLocInDistrict = true;
					
				const SUSPENDED_STR = "suspended";
					
				// Only find observation record for those locations that are not suspended
				if( (locationStatus.toLowerCase() != SUSPENDED_STR.toLowerCase()) && isLocInDistrict ) {
					const queryObservation = new Parse.Query("GCUR_OBSERVATION");
					queryObservation.equalTo("Location", location);	// By _Pointer
					queryObservation.limit(1000);
					queryObservation.notEqualTo("ObservationStatus", 2);						// excludes the archived observation
					queryObservation.ascending("ObservationStatus");							// this enables fetching current(0) and previous(1) observations in order
					const results = await queryObservation.find({ useMasterKey: true });		// results are JavaScript Array of GCUR_OBSERVATION objects						
						
					let observationObjId, areaCuring, validatorCuring, adminCuring, validated;
					let prevOpsCuring;
					let userFuelLoad;
						
					// results length = 0 if there is no observation
					// results length = 1 if there is either current or previous observation; further checking is required
					// results length = 2 if there are both current and previous observations
					if (results.length > 0) {									
						if ((results.length == 1) && (results[0].get("ObservationStatus") == 1)) {		// Only previous observation exists for the Location
							// results[0] is GCUR_OBSERVATION for previous observation
										
							// check if FinalisedDate is 30 days away
							const isPrevObsTooOld = isObsTooOld(results[0].get("FinalisedDate"));
							if (!isPrevObsTooOld) {
								if (results[0].has("AdminCuring")) {
									prevOpsCuring = results[0].get("AdminCuring");
								} else if (results[0].has("ValidatorCuring")) {
									prevOpsCuring = results[0].get("ValidatorCuring");
								} else {
									prevOpsCuring = results[0].get("AreaCuring");
								}
							}
						} else {	// current observation exists
							observationObjId = results[0].id;
							if (results[0].has("AreaCuring"))
								areaCuring = results[0].get("AreaCuring");
							if (results[0].has("ValidatorCuring"))
								validatorCuring = results[0].get("ValidatorCuring");
							if (results[0].has("AdminCuring"))
								adminCuring = results[0].get("AdminCuring");
							if (results[0].has("UserFuelLoad"))
								userFuelLoad = results[0].get("UserFuelLoad");
							
							if (results[0].has("ValidatorCuring") || results[0].has("AdminCuring"))
								validated = "validated";
							
							if (results.length == 2) {		// results[1] is GCUR_OBSERVATION for previous observation											
								// check if FinalisedDate is 30 days away
								const isPrevObsTooOld = isObsTooOld(results[1].get("FinalisedDate"));
								if (!isPrevObsTooOld) {
									if (results[1].has("AdminCuring")) {
										prevOpsCuring = results[1].get("AdminCuring");
									} else if (results[1].has("ValidatorCuring")) {
										prevOpsCuring = results[1].get("ValidatorCuring");
									} else {
										prevOpsCuring = results[1].get("AreaCuring");
									}
								}
							}
						}
					}
								
					obs = {
						"locationObjId": locationObjId,
						"locationName": locationName,
						"locationStatus" : locationStatus,
						"locationLat": locationLat,
						"locationLng": locationLng,
						"locationDistrictNo": locationDistrictNo,
						"locationShareable": locationShareable,
						"observationObjId": observationObjId,
						"areaCuring": areaCuring,
						"validatorCuring": validatorCuring,
						"adminCuring": adminCuring,
						"validated": validated,
						"prevOpsCuring": prevOpsCuring,
						"userFuelLoad": userFuelLoad
					};
					
					obsList.push(obs);
				}
			}
		}
	// If the user is Validator or Administrator
	} else {
		const queryLocation = new Parse.Query("GCUR_LOCATION");
		queryLocation.ascending("LocationName");
		queryLocation.limit(1000);
		const locationResults = await queryLocation.find();
		
		for (let i = 0; i < locationResults.length; i ++) {
			const location = locationResults[i];
			
			const locationObjId = location.id;
			const locationName = location.get("LocationName");
			const locationStatus = location.get("LocationStatus");
			const locationLat = location.get("Lat");
			const locationLng = location.get("Lng");
			const locationDistrictNo = location.get("DistrictNo");
			const locationShareable = location.get("Shareable");
					
			let obs = {};
					
			let isLocInDistrict = false;
			// If the input districtNo is 9999 which is for all districts
			if (districtNo == ALL_DISTRICT)
				isLocInDistrict = true;
			else if (locationDistrictNo == districtNo)
				isLocInDistrict = true;
					
			const SUSPENDED_STR = "suspended";
			//console.log("--- ", locationObjId,  locationName, locationStatus, locationDistrictNo, isLocInDistrict);
			
			// Only find observation record for those locations that are not suspended
			if( (locationStatus.toLowerCase() != SUSPENDED_STR.toLowerCase()) && isLocInDistrict ) {
		       	const queryObservation = new Parse.Query("GCUR_OBSERVATION");
				queryObservation.equalTo("Location", location);	// By _Pointer
				queryObservation.limit(1000);
				queryObservation.notEqualTo("ObservationStatus", 2);	// excludes the archived observation
				queryObservation.ascending("ObservationStatus");	// this enables fetching current(0) and previous(1) observations
				const results = await queryObservation.find({ useMasterKey: true });		// results are JavaScript Array of GCUR_OBSERVATION objects	
								
				let observationObjId, areaCuring, validatorCuring, adminCuring, validated;
				let prevOpsCuring;
				let userFuelLoad, validatorFuelLoad;
								
				// result length = 0 if there is no observation
				// result length = 1 if there is either current or previous observation; further checking is required
				// result length = 2 if there are both current and previous observations
				if (results.length > 0) {
					// Only previous observation exists for the Location
					if ((results.length == 1) && (results[0].get("ObservationStatus") == 1)) {
						// results[0] is GCUR_OBSERVATION for previous observation		
						// check if FinalisedDate is 30 days away
						const isPrevObsTooOld = isObsTooOld(results[0].get("FinalisedDate"));
						if (!isPrevObsTooOld) {
							if (results[0].has("AdminCuring")) {
								prevOpsCuring = results[0].get("AdminCuring");
							} else if (results[0].has("ValidatorCuring")) {
								prevOpsCuring = results[0].get("ValidatorCuring");
							} else {
								prevOpsCuring = results[0].get("AreaCuring");
							}
						}
						
					} else {
						// current observation exists
						observationObjId = results[0].id;
						if (results[0].has("AreaCuring"))
							areaCuring = results[0].get("AreaCuring");
						if (results[0].has("ValidatorCuring"))
							validatorCuring = results[0].get("ValidatorCuring");
						if (results[0].has("AdminCuring"))
							adminCuring = results[0].get("AdminCuring");
						if (results[0].has("UserFuelLoad"))
							userFuelLoad = results[0].get("UserFuelLoad");
						if (results[0].has("ValidatorFuelLoad"))
							validatorFuelLoad = results[0].get("ValidatorFuelLoad");
						if (results[0].has("ValidatorCuring") || results[0].has("AdminCuring"))
							validated = "validated";
										
						if (results.length == 2) {
							// results[1] is GCUR_OBSERVATION for previous observation
							// check if FinalisedDate is 30 days away
							const isPrevObsTooOld = isObsTooOld(results[1].get("FinalisedDate"));
							if (!isPrevObsTooOld) {
								if (results[1].has("AdminCuring")) {
									prevOpsCuring = results[1].get("AdminCuring");
								} else if (results[1].has("ValidatorCuring")) {
									prevOpsCuring = results[1].get("ValidatorCuring");
								} else {
									prevOpsCuring = results[1].get("AreaCuring");
								}
							}
						}
					}
				}

				obs = {
					"locationObjId" : locationObjId,
					"locationName" : locationName,
					"locationStatus" : locationStatus,
					"locationLat" : locationLat,
					"locationLng" : locationLng,
					"locationDistrictNo" : locationDistrictNo,
					"locationShareable" : locationShareable,
					"observationObjId" : observationObjId,
					"areaCuring" : areaCuring,
					"validatorCuring" : validatorCuring,
					"adminCuring" : adminCuring,
					"validated" : validated,
					"prevOpsCuring" : prevOpsCuring,
					"userFuelLoad" : userFuelLoad,
					"validatorFuelLoad" : validatorFuelLoad
				};
					
				obsList.push(obs);
			}
		}
	}
	
	return obsList;
});

Parse.Cloud.define("getObsForInputToVISCA", (request) => {
	var obsList = [];	// the output array for response

	var queryObservation = new Parse.Query("GCUR_OBSERVATION");
	queryObservation.equalTo("ObservationStatus", 0);			// Current week's observations
	queryObservation.limit(1000);
	queryObservation.include("Location");
	return queryObservation.find().then(function(results) {
		
		for (var i = 0; i < results.length; i ++) {
			var locObjId = locName = locLat = locLng = undefined;
			var obsObjId = areaCuring = validatorCuring = adminCuring = bestCuring = undefined;
			var isValidated = 0;
			var equivalentFuelLoad = validatorFuelLoad = undefined;		// "EquivalentFuelLoad" is "UserFuelLoad";
			var fuelContinuity = fuelQuantity = undefined;
			
			var obs = results[i];	// "obs" is a GCUR_OBSERVATION object
			
			var location = obs.get("Location");
			locObjId = location.id;
			locName = location.get("LocationName");
			locLat = location.get("Lat");
			locLng = location.get("Lng");
			
			obsObjId = obs.id;
			
			if (obs.has("AreaCuring"))
				areaCuring = obs.get("AreaCuring");
			if (obs.has("ValidatorCuring"))
				validatorCuring = obs.get("ValidatorCuring");
			if (obs.has("AdminCuring"))
				adminCuring = obs.get("AdminCuring");
			if (obs.has("UserFuelLoad"))
				equivalentFuelLoad = obs.get("UserFuelLoad");
			if (obs.has("ValidatorFuelLoad"))
				validatorFuelLoad = obs.get("ValidatorFuelLoad");
			if (obs.has("FuelContinuity"))
				fuelContinuity = obs.get("FuelContinuity");
			if (obs.has("FuelQuantity"))
				fuelQuantity = obs.get("FuelQuantity");
			
			if (obs.has("AdminCuring")) {
				bestCuring = obs.get("AdminCuring");
			} else if (obs.has("ValidatorCuring")) {
				bestCuring = obs.get("ValidatorCuring");
			} else if (obs.has("AreaCuring")) {
				bestCuring = obs.get("AreaCuring");
			}
			
			if (obs.has("ValidatorCuring") || obs.has("AdminCuring") || obs.has("ValidatorFuelLoad"))
				isValidated = 1;
			
			var obsJSON = {
					"obsObjId" : obsObjId,
					"locObjId" : 	locObjId,
					"locName" : locName,
					"locLat": locLat,
					"locLng": locLng,
					"areaCuring" : areaCuring,
					"validatorCuring" : validatorCuring,
					"adminCuring" : adminCuring,
					"bestCuring" : bestCuring,
					"isValidated" : isValidated,
					"equivalentFuelLoad" : equivalentFuelLoad,
					"validatorFuelLoad" : validatorFuelLoad,
					"fuelContinuity" : fuelContinuity,
					"fuelQuantity" : fuelQuantity
			};
			//console.log("*** " + locName + ". validatorCuring = " + validatorCuring + ". validatorFuelLoad = " + validatorFuelLoad)
			
			obsList.push(obsJSON);
			
			// Sort by locName, case-insensitive, A-Z
			obsList.sort(sort_by('locName', false, function(a){return a.toUpperCase()}));
		}

		return Promise.resolve("okay");
	}).then(function() {
	    return obsList;
	}, function(error) {
		throw new Error("Error: " + error.code + " " + error.message);
	});
});

/**
 * Triggered when user clicks Validate Observations to show District List and count of associated observations
 */
Parse.Cloud.define("getCountOfLocsForDistricts", async (request) => {	
	const districtList = [];	// the output array for response
	
	// Find districts
	const queryDistrict = new Parse.Query("GCUR_DISTRICT");
	queryDistrict.ascending("DIST_NAME");
	queryDistrict.limit(1000);
	queryDistrict.select("DISTRICT", "DIST_NAME");
	const districtResults = await queryDistrict.find();
	
	// For each district, find count of locations that fall into the district.
	for (let i = 0; i < districtResults.length; i ++) {
		const district = districtResults[i];
		const districtObjId = district.id;
		const districtNo = district.get("DISTRICT");
		const districtName = district.get("DIST_NAME");
		
		const queryLocation = new Parse.Query("GCUR_LOCATION");
		queryLocation.equalTo("DistrictNo", districtNo);
		queryLocation.notEqualTo("LocationStatus", "suspended");
		queryLocation.limit(1000);
		queryLocation.ascending("LocationName");
		const locationResults = await queryLocation.find();
		
		const countOfLocations = locationResults.length;
		
		const res = {
			"districtObjId" : districtObjId,
			"districtNo" : 	districtNo,
			"districtName" : districtName,
			"countOfLocations" : countOfLocations
		};
		districtList.push(res);
	}
	
	return districtList;
});

Parse.Cloud.define("deleteCurrObservationForLocation", (request) => {
	var locObjectId = request.params.locObjectId;
	var locName = null;
	
	var queryLocation = new Parse.Query("GCUR_LOCATION");
	queryLocation.equalTo("objectId", locObjectId);
	return queryLocation.first().then(function(gloc) {
		locName = gloc.get("LocationName");
		
		var queryObservation = new Parse.Query("GCUR_OBSERVATION");
		queryObservation.equalTo("Location", gloc);		// By _Pointer
		queryObservation.equalTo("ObservationStatus", 0);	// Current observation
		
		return queryObservation.find();
	}, function(error) {
		throw new Error("Error: " + error.code + " " + error.message);
	}).then(function(observations) {
		// If no observation was found.
		if (observations.length == 0) {
			return Promise.reject("There was no current observation record for location " + locObjectId + " - " + locName);
		}
		return Parse.Object.destroyAll(observations);
	}).then(function() {
		console.log('Current GCUR_OBSERVATION records for location ' + locName + ' have been successfully deleted.');
		return true;
	}, function(error) {
		throw new Error(error);
	});
});

// Referenced by the observationDetails.jsp page object when action is "showObservationDetails"
Parse.Cloud.define("getCurrPrevSimpleObservationsForLocation", async (request) => {
	const locObjectId = request.params.locObjectId;
	
	const queryLocation = new Parse.Query("GCUR_LOCATION");
	queryLocation.equalTo("objectId", locObjectId);
	
	const locResult = await queryLocation.first({ useMasterKey: true });

	const location = locResult;		
	const locName = location.get("LocationName");
	const locStatus = location.get("LocationStatus");
		
	const queryObservation = new Parse.Query("GCUR_OBSERVATION");
	queryObservation.equalTo("Location", location);	// By _Pointer
	queryObservation.include("Observer");
	queryObservation.include("Validator");
	queryObservation.include("Administrator");
	queryObservation.include("Location");
	queryObservation.include("RateOfDrying");
	queryObservation.limit(1000);
	queryObservation.notEqualTo("ObservationStatus", 2);	// excludes the archived observation
	queryObservation.ascending("ObservationStatus");	// this enables fetching current(0) and previous(1) observations
	
	const results = await queryObservation.find({ useMasterKey: true });
	// results are JavaScript Array of GCUR_OBSERVATION objects
	//console.log("GCUR_OBSERVATION - find " + results.length + " records for GCUR_LOCATION " + locObjectId + ", " + locName);
	
	let returnedJSON = {
		"locationObjId" : locObjectId,
		"locationName" : locName,
		"locationStatus" : locStatus
	};
	
	if (results.length > 0) {
		let currObservationObjectId, currObservationDate, currObserverObjectId, currObserverName;
		let currPointCuring, currPointHeight, currPointCover, currPointFuelLoad, currAreaCuring, currAreaHeight, currAreaCover, currAreaFuelLoad, currRainfall, currRodObjectId, currComment, currUserFuelLoad, currFuelContinuity, currFuelQuantity;
		let currValidationDate, currValidatorObjectId, currValidatorName, currValidatorCuring, currValidatorFuelLoad;
		let currAdminDate, currAdminObjectId, currAdminName, currAdminCuring;
		let prevObservationObjectId, prevPointCuring, prevPointHeight, prevPointCover, prevPointFuelLoad, prevAreaCuring, prevAreaHeight, prevAreaCover, prevAreaFuelLoad, prevRainfall, prevRodObjectId, prevUserFuelLoad, prevFuelContinuity, prevFuelQuantity;
		let prevOpsCuring;	// in total 35 attributes
			
		// Only previous observation exists for the Location
		if ((results.length == 1) && (results[0].get("ObservationStatus") == 1)) {
				// results[0] is GCUR_OBSERVATION for previous observation
				
				// check if FinalisedDate is 30 days away
				let isPrevObsTooOld = isObsTooOld(results[0].get("FinalisedDate"));
				if (!isPrevObsTooOld) {
					prevObservationObjectId = results[0].id;
					if (results[0].has("PointCuring"))
						prevPointCuring = results[0].get("PointCuring");
					if (results[0].has("PointHeight"))
						prevPointHeight = results[0].get("PointHeight");
					if (results[0].has("PointCover"))
						prevPointCover = results[0].get("PointCover");
					if (results[0].has("PointFuelLoad"))
						prevPointFuelLoad = results[0].get("PointFuelLoad");
					if (results[0].has("AreaCuring"))
						prevAreaCuring = results[0].get("AreaCuring");
					if (results[0].has("AreaHeight"))
						prevAreaHeight = results[0].get("AreaHeight");
					if (results[0].has("AreaCover"))
						prevAreaCover = results[0].get("AreaCover");
					if (results[0].has("AreaFuelLoad"))
						prevAreaFuelLoad = results[0].get("AreaFuelLoad");
					if (results[0].has("UserFuelLoad"))
						prevUserFuelLoad = results[0].get("UserFuelLoad");
					if (results[0].has("FuelContinuity"))
						prevFuelContinuity = results[0].get("FuelContinuity");
					if (results[0].has("FuelQuantity"))
						prevFuelQuantity = results[0].get("FuelQuantity");
					if (results[0].has("Rainfall"))
						prevRainfall = results[0].get("Rainfall");
					if (results[0].has("RateOfDrying")) {
						const prevRateOfDrying = results[0].get("RateOfDrying");
						prevRodObjectId = prevRateOfDrying.id;
					}
					
					if (results[0].has("AdminCuring")) {
						prevOpsCuring = results[0].get("AdminCuring");
					} else if (results[0].has("ValidatorCuring")) {
						prevOpsCuring = results[0].get("ValidatorCuring");
					}
					/*
					else {
						prevOpsCuring = results[0].get("AreaCuring");
					}
					*/
				}
		} else {// current observation exists
				// Observer's current observation details
				currObservationObjectId = results[0].id;
				if (results[0].has("ObservationDate")) {
					currObservationDate = results[0].get("ObservationDate");
				}
				if (results[0].has("Observer")) {
					const observer = results[0].get("Observer");
					currObserverObjectId = observer.id;
					//currObserverName = observer.get("username");
					currObserverName = observer.get("firstName") + " " + observer.get("lastName");
				}
				if (results[0].has("PointCuring"))
					currPointCuring = results[0].get("PointCuring");
				if (results[0].has("PointHeight"))
					currPointHeight = results[0].get("PointHeight");
				if (results[0].has("PointCover"))
					currPointCover = results[0].get("PointCover");
				if (results[0].has("PointFuelLoad"))
					currPointFuelLoad = results[0].get("PointFuelLoad");
				if (results[0].has("AreaCuring"))
					currAreaCuring = results[0].get("AreaCuring");
				if (results[0].has("AreaHeight"))
					currAreaHeight = results[0].get("AreaHeight");
				if (results[0].has("AreaCover"))
					currAreaCover = results[0].get("AreaCover");
				if (results[0].has("AreaFuelLoad"))
					currAreaFuelLoad = results[0].get("AreaFuelLoad");
				if (results[0].has("UserFuelLoad"))
					currUserFuelLoad = results[0].get("UserFuelLoad");
				if (results[0].has("FuelContinuity"))
					currFuelContinuity = results[0].get("FuelContinuity");
				if (results[0].has("FuelQuantity"))
					currFuelQuantity = results[0].get("FuelQuantity");
				if (results[0].has("Rainfall"))
					currRainfall = results[0].get("Rainfall");
				if (results[0].has("RateOfDrying")) {
					const currRateOfDrying = results[0].get("RateOfDrying");
					currRodObjectId = currRateOfDrying.id;
				}
				if (results[0].has("Comments"))
					currComment = results[0].get("Comments");
				
				// validator's observation details
				if (results[0].has("ValidationDate"))
					currValidationDate = results[0].get("ValidationDate");			
				if (results[0].has("Validator")) {
					const validator = results[0].get("Validator");
					currValidatorObjectId = validator.id;
					currValidatorName = validator.get("username");
				}
				if (results[0].has("ValidatorCuring"))
					currValidatorCuring = results[0].get("ValidatorCuring");
				if (results[0].has("ValidatorFuelLoad"))
					currValidatorFuelLoad = results[0].get("ValidatorFuelLoad");
				
				// admin's observation details
				if (results[0].has("AdminDate"))
					currAdminDate = results[0].get("AdminDate");			
				if (results[0].has("Administrator")) {
					const administrator = results[0].get("Administrator");
					currAdminObjectId = administrator.id;
					currAdminName = administrator.get("username");
				}
				if (results[0].has("AdminCuring"))
					currAdminCuring = results[0].get("AdminCuring");
				
				// Previous observation does exist along with the current observation
				if (results.length == 2) {
					// results[1] is GCUR_OBSERVATION for previous observation
					
					// check if FinalisedDate is 30 days away
					const isPrevObsTooOld = isObsTooOld(results[1].get("FinalisedDate"));
					if (!isPrevObsTooOld) {
						prevObservationObjectId = results[1].id;
						if (results[1].has("PointCuring"))
							prevPointCuring = results[1].get("PointCuring");
						if (results[1].has("PointHeight"))
							prevPointHeight = results[1].get("PointHeight");
						if (results[1].has("PointCover"))
							prevPointCover = results[1].get("PointCover");
						if (results[1].has("PointFuelLoad"))
							prevPointFuelLoad = results[1].get("PointFuelLoad");
						if (results[1].has("AreaCuring"))
							prevAreaCuring = results[1].get("AreaCuring");
						if (results[1].has("AreaHeight"))
							prevAreaHeight = results[1].get("AreaHeight");
						if (results[1].has("AreaCover"))
							prevAreaCover = results[1].get("AreaCover");
						if (results[1].has("AreaFuelLoad"))
							prevAreaFuelLoad = results[1].get("AreaFuelLoad");
						if (results[1].has("UserFuelLoad"))
							prevUserFuelLoad = results[1].get("UserFuelLoad");
						if (results[1].has("FuelContinuity"))
							prevFuelContinuity = results[1].get("FuelContinuity");
						if (results[1].has("FuelQuantity"))
							prevFuelQuantity = results[1].get("FuelQuantity");
						if (results[1].has("Rainfall"))
							prevRainfall = results[1].get("Rainfall");
						if (results[1].has("RateOfDrying")) {
							const prevRateOfDrying = results[1].get("RateOfDrying");
							prevRodObjectId = prevRateOfDrying.id;
						}
						
						if (results[1].has("AdminCuring")) {
							prevOpsCuring = results[1].get("AdminCuring");
						} else if (results[1].has("ValidatorCuring")) {
							prevOpsCuring = results[1].get("ValidatorCuring");
						} 
						/*
						else {
							prevOpsCuring = results[1].get("AreaCuring");
						}
						*/
					}
				}
		}
			
		let currPrevObsDetails = {
					"currObservationObjectId" : currObservationObjectId,
					"currObservationDate" : currObservationDate,
					"currObserverObjectId" : currObserverObjectId,
					"currObserverName" : currObserverName,
					"currPointCuring" : currPointCuring,
					"currPointHeight" : currPointHeight,
					"currPointCover" : currPointCover,
					"currPointFuelLoad" : currPointFuelLoad,
					"currAreaCuring" : currAreaCuring,
					"currAreaHeight" : currAreaHeight,
					"currAreaCover" : currAreaCover,
					"currAreaFuelLoad" : currAreaFuelLoad,
					"currUserFuelLoad" : currUserFuelLoad,
					"currFuelContinuity" : currFuelContinuity,
					"currFuelQuantity" : currFuelQuantity,
					"currRainfall" : currRainfall,
					"currRodObjectId" : currRodObjectId,
					"currComment" : currComment,
					"currValidationDate" : currValidationDate,
					"currValidatorObjectId" : currValidatorObjectId,
					"currValidatorName" : currValidatorName,
					"currValidatorCuring" : currValidatorCuring,
					"currValidatorFuelLoad" : currValidatorFuelLoad,
					"currAdminDate" : currAdminDate,
					"currAdminObjectId" : currAdminObjectId,
					"currAdminName" : currAdminName,
					"currAdminCuring" : currAdminCuring,
					"prevObservationObjectId" : prevObservationObjectId,
					"prevPointCuring" : prevPointCuring,
					"prevPointHeight" : prevPointHeight,
					"prevPointCover" : prevPointCover,
					"prevPointFuelLoad" : prevPointFuelLoad,
					"prevAreaCuring" : prevAreaCuring,
					"prevAreaHeight" : prevAreaHeight,
					"prevAreaCover" : prevAreaCover,
					"prevAreaFuelLoad" : prevAreaFuelLoad,
					"prevUserFuelLoad" : prevUserFuelLoad,
					"prevFuelContinuity" : prevFuelContinuity,
					"prevFuelQuantity" : prevFuelQuantity,
					"prevRainfall" : prevRainfall,
					"prevRodObjectId" : prevRodObjectId,
					"prevOpsCuring" : prevOpsCuring
		};
						
		returnedJSON["currPrevObsDetails"] = currPrevObsDetails;			
	}

	return returnedJSON;
});

Parse.Cloud.define("getAllFuelLoadLookupItems", async (request) => {
	const query = new Parse.Query("GCUR_LOOKUP_FUELLOAD");
	query.limit(1000);
	query.ascending("height");
	const returnedJSON = [];

	const results = await query.find();

	for (var i = 0; i < results.length; i++) {
		const rod = {
				"height" : results[i].get("height"),
				"cover" : results[i].get("cover"),
				"fuel_load" : results[i].get("fuel_load")
		};
		
		returnedJSON.push(rod);
	}

	return returnedJSON;
});

Parse.Cloud.define("getAllAdjByLocDists", async (request) => {
	const query = new Parse.Query("GCUR_ADJUST_LOCATION_LOOKUP_DIST");
	query.limit(1000);
	query.ascending("distance");
	const returnedJSON = [];
	const results = await query.find();
	for (let i = 0; i < results.length; i++) {
		const dist = {
			"d" : results[i].get("distance")
		};
		
		returnedJSON.push(dist);
	}
	return returnedJSON;
});

/**
 * Link an observer with locations page; called from the Link Observer with Locations page.
 */
Parse.Cloud.define("getAllLocationsWithLinkedStatusForObservers", async (request) => {
	const userObjectId = request.params.objectId;
	const allLocs = [];
	
	const queryLocation = new Parse.Query("GCUR_LOCATION");
	queryLocation.ascending("LocationName");
	queryLocation.limit(1000);
	const locations = await queryLocation.find();

	//console.log("All locations count: " + locations.length);
	for (let i = 0; i < locations.length; i++) {
		const loc = {
			"locationId" : locations[i].id,
			"locationName" : locations[i].get("LocationName"),
			"locationStatus" : locations[i].get("LocationStatus"),
			"linked" : false
		};
			
		allLocs.push(loc);
	}

	// Find the user
	const queryUser = new Parse.Query(Parse.User);
	queryUser.equalTo("objectId", userObjectId);
	const user = await queryUser.first({ useMasterKey: true });
	const userName = user.get("username");
	const firstName = user.get("firstName");
	const lastName = user.get("lastName");
	//console.log("userName - " + userName);

	const queryMMR = new Parse.Query("GCUR_MMR_OBSERVER_LOCATION");
	queryMMR.include("Observer");
	queryMMR.include("Location");
	queryMMR.limit(1000);
	const mmrResults = await queryMMR.find({ useMasterKey: true });

	for (let i = 0; i < mmrResults.length; i++) {
		const user = mmrResults[i].get("Observer");
	    const usrObjId = user.id;
	    if (usrObjId == userObjectId) {
	        const location = mmrResults[i].get("Location");
	            
	        for (let j = 0; j < allLocs.length; j++) {
	            if (allLocs[j]["locationId"] == location.id) {
	            	allLocs[j]["linked"] = true;
	            	break;
	            }
	        }
	    }
	}
	      
	const locationsForUser = {
	    "userObjectId": userObjectId,
	    "userName": userName,
	    "firstName": firstName,
	    "lastName": lastName,
	    "locationList": allLocs
	};
	return locationsForUser;
});

/**
 * updateLinkedLocsForObserverByIds:
 * Update association of existing locations with observer
 * Called from ManageAccess Servlet action= linkLocationsToObserver;
 * called from the Submit button on the Link Observer with Locations page.
 * 
 */
Parse.Cloud.define("updateLinkedLocsForObserverByIds", (request) => {
	console.log("*** updateLinkedLocsForObserverByIds called");
	var observerObjId = request.params.observerObjId;	// String
	var mmrObjsToBeRemoved = [];
	var newLinkedLocsIds = [];	// all new linked locations' Ids
	
	for (var i = 0; i < request.params.linkedLocsIds.length; i ++) {
		//console.log("New linked locations for Observer [" + observerObjId + "]: " + request.params.linkedLocsIds[i]["locId"]);
		newLinkedLocsIds.push(request.params.linkedLocsIds[i]["locId"]);
	}
	
	var queryMMR = new Parse.Query("GCUR_MMR_OBSERVER_LOCATION");
	queryMMR.include("Observer");
	queryMMR.include("Location");
	queryMMR.limit(1000);
	return queryMMR.find({ useMasterKey: true }).then(function(results) {
		for (var i = 0; i < results.length; i ++) {
			var user = results[i].get("Observer");
	        if (user.id == observerObjId) {
	        	mmrObjsToBeRemoved.push(results[i]);
	        }
		}
		console.log("MMR_Observer_Location to be remove [count]: " + mmrObjsToBeRemoved.length);
		
		// Remove all existing MMR records for the ObserverId
		return Parse.Object.destroyAll(mmrObjsToBeRemoved);
	}).then(function() {
		console.log("All existing MMR Observer Location records successfully deleted");
		var MMRToBeSaved = [];
		
		for (var j = 0; j < newLinkedLocsIds.length; j ++) {
			var observer = new Parse.User();
			observer.id = observerObjId;
			
			var GCUR_LOCATION = Parse.Object.extend("GCUR_LOCATION");
			var location = new GCUR_LOCATION();
			location.id = newLinkedLocsIds[j];
			
			var GCUR_MMR_OBSERVER_LOCATION = Parse.Object.extend("GCUR_MMR_OBSERVER_LOCATION");
			var mmr_obsvr_loc = new GCUR_MMR_OBSERVER_LOCATION();
			mmr_obsvr_loc.set("Observer", observer);
			mmr_obsvr_loc.set("Location", location);
			
			MMRToBeSaved.push(mmr_obsvr_loc);
		}
		
		return Parse.Object.saveAll(MMRToBeSaved, { useMasterKey: true });
	}, function(error) {
		// An error occurred while deleting one or more of the objects.
	      // If this is an aggregate error, then we can inspect each error
	      // object individually to determine the reason why a particular
	      // object was not deleted.
	      if (error.code == Parse.Error.AGGREGATE_ERROR) {
	        for (var i = 0; i < error.errors.length; i++) {
	          console.log("Couldn't delete " + error.errors[i].object.id +
	            "due to " + error.errors[i].message);
	        }
	      } else {
	        console.log("Delete aborted because of " + error.message);
	      }
	      
		throw new Error("Error: " + error.code + " " + error.message);
	}).then(function(objectList) {
		// all the objects were saved.
		var mmrIds = [];
		
		for (var y = 0; y < objectList.length; y ++) {
			mmrIds.push(objectList[y].id);
		}
		
		var newCreatedMMRObjIds = {
		    "mmrObjIds": mmrIds
		};
		
		return newCreatedMMRObjIds;
	}, function(error) {
		throw new Error("Error: " + error.code + " " + error.message);
	});
});

/**
 * Triggered by action= acceptAllObserverValues
 */
Parse.Cloud.define("acceptAllObserverCurings", (request) => {
	var ALL_DISTRICT = "9999";		// If the districtNo == 9999, return all active locatons.
	
	var validatorObjId = request.params.validatorObjId;		// String
	var districtNo = request.params.districtNo;				// If districtNo == ALL_DISTRICT, validate all active locations.
	
	console.log("*** acceptAllObserverCurings called by Validator [" + validatorObjId + "]");
	
	var sessionToken = undefined;
	if (request.user != undefined) {
		sessionToken = request.user.getSessionToken();
		//console.log("* request.user.id = " + request.user.id);
	}
	
	var queryObservation = new Parse.Query("GCUR_OBSERVATION");
	queryObservation.equalTo("ObservationStatus", 0);	// All current observation records
	queryObservation.greaterThanOrEqualTo("AreaCuring", 0);
	queryObservation.limit(1000);
	// Include the Location data with each GCUR_OBSERVATION
	queryObservation.include("Location");
	return queryObservation.find().then(function(results) {
		for (var i = 0; i < results.length; i ++) {
			var obs = results[i];
			
			var location = obs.get("Location");
			var locationObjId = location.id;
			var locationDistrictNo = location.get("DistrictNo");
			
			var isLocInDistrict = false;
			// If the input districtNo is 9999 which is for all districts
			if (districtNo == ALL_DISTRICT)
				isLocInDistrict = true;
			else if (locationDistrictNo == districtNo)
				isLocInDistrict = true;
			
			// If the input districtNo == location's DistrictNo
			if ( isLocInDistrict ) {
				var areaCuring = obs.get("AreaCuring");
				var currDateTime = new Date();
				var validator = new Parse.User();
				validator.id = validatorObjId;
				
				obs.set("ValidatorCuring", areaCuring);
				obs.set("ValidationDate", currDateTime);
				obs.set("Validator", validator);
				//obs.save();
			}
		}
		
		return Parse.Object.saveAll(results, { useMasterKey: true });
	}).then(function(objectList) {
		return objectList.length;
	}, function(error) {
		throw new Error("Error: " + error.code + " " + error.message);
	});
});

/**
 * Called from retrieveAdjustByDistrictObjectsByStatus JS functin on the adminTools.jsp page.
 * * Retrieve all Districts with their adjusted curings by user-specific status.
	 * Status : 0 = current GCUR_ADJUST_DISTRICT records. Initial when page load.
	 *			1 = previous GCUR_ADJUST_DISTRICT records. "Get Previous Values" button clicked.
	 *			2 = archived GCUR_ADJUST_DISTRICT records. Not used.
	 *		   -1 = empty GCUR_ADJUST_DISTRICT records. "Clear Selections" button clicked.
 */
Parse.Cloud.define("getAdjustedCuringForAllDistricts", async (request) => {
	const status = request.params.status;	// "status" = 0 (current), or = 1 (previous)
	const distAdjustedCuringList = [];	// the output array for response

	const queryDistrict = new Parse.Query("GCUR_DISTRICT");
	queryDistrict.ascending("DISTRICT");
	queryDistrict.limit(1000);
	const districtResults = await queryDistrict.find();
	for (let i = 0 ; i < districtResults.length; i ++) {
		const gcur_district = districtResults[i];
	    const districtObjId = gcur_district.id;
	    const districtNo = gcur_district.get("DISTRICT");
	    const districtName = gcur_district.get("DIST_NAME");
	    
	    const queryAdjustDistrict = new Parse.Query("GCUR_ADJUST_DISTRICT");
	    queryAdjustDistrict.ascending("district");
	    queryAdjustDistrict.equalTo("district", districtNo);
	    queryAdjustDistrict.equalTo("status", status);		// status is user-specific, so it can be either current week or previous week
	    queryAdjustDistrict.limit(1000);

		const adjustDistrctResults = await queryAdjustDistrict.find();

		// results are JavaScript Array of GCUR_ADJUST_DISTRICT objects;
		// the length can only be either 0 or 1;
		let thisDistrict, adjustedCuring, thisStatus, adjustDistrictObjId;
					
		if (adjustDistrctResults.length > 0) {
			// The DISTRICT has an adjustedCuring and status record in GCUR_ADJUST_DISTRICT
			adjustDistrictObjId = adjustDistrctResults[0].id;
			thisDistrict = adjustDistrctResults[0].get("district");
			adjustedCuring = adjustDistrctResults[0].get("adjustedCuring");
			thisStatus = adjustDistrctResults[0].get("status");
		} else {
			// The DISTRICT does not have an adjustedCuring and status
			adjustDistrictObjId = "";
			thisDistrict = districtNo;
			adjustedCuring = NULL_VAL_INT;
			thisStatus = status;
		}
					
		//
		const distAdjustedCuringObj = {
			"adjustDistrictObjId": adjustDistrictObjId,
			"districtNo": thisDistrict,
			"districtName": districtName,
			"adjustedCuring": adjustedCuring,
			"status": thisStatus
		};

		distAdjustedCuringList.push(distAdjustedCuringObj);
	}

	return distAdjustedCuringList;
});

/**
 * Called from Submit click on saveAdjustByDistrictValues JS function on the adminTools.jsp page.
 */
Parse.Cloud.define("createUpdateCurrGCURAdjustDistrict", (request) => {
	
	/*
	 * An example of request parameter
	 * {"newAdjustByDistrictObjs":[
	 * 	{"status":0,"adjustedCuring":20,"district":2},
	 * 	{"status":0,"adjustedCuring":40,"district":4},
	 * 	{"status":0,"adjustedCuring":60,"district":6}]
	 * }
	 */
	
	var newAdjustByDistrictObjs = request.params.newAdjustByDistrictObjs;
	
	// Remove all the existing current GCUR_ADJUST_DISTRICT records from the GCUR_ADJUST_DISTRICT class
	var queryDistrict = new Parse.Query("GCUR_ADJUST_DISTRICT");
	queryDistrict.limit(1000);
	queryDistrict.equalTo("status", 0);	// All current GCUR_ADJUST_DISTRICT records
	return queryDistrict.find().then(function(results) {
		
		// Do remove about all current GCUR_ADJUST_DISTRICT records
		return Parse.Object.destroyAll(results);
	}).then(function() {
		//console.log("All current GCUR_ADJUST_DISTRICT (status = 0) records have been successfully deleted");
		
		var AdjustDistrictsToBeSaved = [];
		
		for (var j = 0; j < newAdjustByDistrictObjs.length; j ++) {
			var district = newAdjustByDistrictObjs[j]["district"];
			var adjustedCuring = newAdjustByDistrictObjs[j]["adjustedCuring"];
			var status = newAdjustByDistrictObjs[j]["status"];
			
			//console.log("New AdjustByDistrict - [" + district + "]: " + adjustedCuring + ", " + status);
			
			var GCUR_ADJUST_DISTRICT = Parse.Object.extend("GCUR_ADJUST_DISTRICT");
			var newAdjustDistrict = new GCUR_ADJUST_DISTRICT();
			newAdjustDistrict.set("district", district);
			newAdjustDistrict.set("adjustedCuring", adjustedCuring);
			newAdjustDistrict.set("status", status);
			
			AdjustDistrictsToBeSaved.push(newAdjustDistrict);
		}
		
		return Parse.Object.saveAll(AdjustDistrictsToBeSaved, { useMasterKey: true });
	}, function(error) {
		// ERROR ON destroyAll()
		// An error occurred while deleting one or more of the objects.
	      // If this is an aggregate error, then we can inspect each error
	      // object individually to determine the reason why a particular
	      // object was not deleted.
	      if (error.code == Parse.Error.AGGREGATE_ERROR) {
	        for (var i = 0; i < error.errors.length; i++) {
	          console.log("Couldn't delete " + error.errors[i].object.id +
	            "due to " + error.errors[i].message);
	        }
	      } else {
	        console.log("Delete aborted because of " + error.message);
	      }
	      
		throw new Error("Error: " + error.code + " " + error.message);
	}).then(function(objectList) {
		// all the new GCUR_ADJUST_DISTRICT objects were saved.
		var newAdjustDistrictIds = [];
		
		for (var y = 0; y < objectList.length; y ++) {
			newAdjustDistrictIds.push(objectList[y].id);
		}
		
		var createdAdjustDistrictIds = {
		    "createdAdjustDistrictIds": newAdjustDistrictIds
		};
		
		return createdAdjustDistrictIds;
	}, function(error) {
		throw new Error("Error: " + error.code + " " + error.message);
	});
});

Parse.Cloud.define("getAdjustedCuringForLocations", async (request) => {
	const status = request.params.status;	// "status" = 0 (current), or = 1 (previous)
	const locAdjustedCuringList = [];	// the output array for response

	const queryAdjustLoc = new Parse.Query("GCUR_ADJUST_LOCATION");
	queryAdjustLoc.ascending("location");
	queryAdjustLoc.equalTo("status", status);		// status is user-specific, so it can be either current week or previous week
	queryAdjustLoc.limit(1000);
	queryAdjustLoc.include("location");

	const results = await queryAdjustLoc.find();
	for (let i = 0; i < results.length; i ++) {
		const adjustByLoc = results[i];
		
		const location = adjustByLoc.get("location");
		const locationId = location.id;
		const locationName = location.get("LocationName");
		
		const adjustedCuring = adjustByLoc.get("adjustedCuring");
		
		const adjustedDistance = adjustByLoc.get("adjustedDistance");
		
		const locAdjustedCuringObj = {
				"locObjId": locationId,
				"locName": locationName,
				"adjustedCuring": adjustedCuring,
				"adjustedDistance": adjustedDistance
		};
		
		locAdjustedCuringList.push(locAdjustedCuringObj);
	}

	//console.log(locAdjustedCuringList);
	return locAdjustedCuringList;	
});

/**
 * Called from Submit click on saveAdjustByLocationValues JS function on the adminTools.jsp page.
 */
Parse.Cloud.define("createUpdateCurrGCURAdjustLocation", (request) => {
	
	/*
	 * An example of request parameter
	 * {"newAdjustByLocationObjs":[
	 * 	{"status":0,"adjustedCuring":100,"adjustedDistance":24,"locObjId":"kgQ8puq5lC"},
	 * 	{"status":0,"adjustedCuring":90,"adjustedDistance":48,"locObjId":"ZuYu1Neenj"},
	 * 	{"status":0,"adjustedCuring":60,"adjustedDistance":72,"locObjId":"CvyfGSYArB"}]
	 * }
	 */
	console.log("*** Cloud fucntion createUpdateCurrGCURAdjustLocation called");
	var newAdjustByLocationObjs = request.params.newAdjustByLocationObjs;
	
	// Remove all the existing current GCUR_ADJUST_LOCATION records from the GCUR_ADJUST_LOCATION class
	var queryLocation = new Parse.Query("GCUR_ADJUST_LOCATION");
	queryLocation.limit(1000);
	queryLocation.equalTo("status", 0);	// All current GCUR_ADJUST_LOCATION records
	return queryLocation.find().then(function(results) {
		
		// Do remove about all current GCUR_ADJUST_LOCATION records
		return Parse.Object.destroyAll(results);
	}).then(function() {
		//console.log("All current GCUR_ADJUST_LOCATION (status = 0) records have been successfully deleted");
		
		var AdjustLocationsToBeSaved = [];
		
		for (var j = 0; j < newAdjustByLocationObjs.length; j ++) {
			var locObjId = newAdjustByLocationObjs[j]["locObjId"];
			var adjustedCuring = newAdjustByLocationObjs[j]["adjustedCuring"];
			var adjustedDistance = newAdjustByLocationObjs[j]["adjustedDistance"];
			var status = newAdjustByLocationObjs[j]["status"];
			
			//console.log("New AdjustByLocation to be added - [" + locObjId + "]: " + adjustedCuring + ", " + adjustedDistance + ", " + status);
			
			var GCUR_LOCATION = Parse.Object.extend("GCUR_LOCATION");
			var location = new GCUR_LOCATION();
			location.id = locObjId;
			
			var GCUR_ADJUST_LOCATION = Parse.Object.extend("GCUR_ADJUST_LOCATION");
			var newAdjustLocation = new GCUR_ADJUST_LOCATION();
			newAdjustLocation.set("location", location);
			newAdjustLocation.set("adjustedCuring", adjustedCuring);
			newAdjustLocation.set("adjustedDistance", adjustedDistance);
			newAdjustLocation.set("status", status);
			
			AdjustLocationsToBeSaved.push(newAdjustLocation);
		}
		
		return Parse.Object.saveAll(AdjustLocationsToBeSaved, { useMasterKey: true });
	}, function(error) {
		// ERROR ON destroyAll()
		// An error occurred while deleting one or more of the objects.
	      // If this is an aggregate error, then we can inspect each error
	      // object individually to determine the reason why a particular
	      // object was not deleted.
	      if (error.code == Parse.Error.AGGREGATE_ERROR) {
	        for (var i = 0; i < error.errors.length; i++) {
	          console.log("Couldn't delete " + error.errors[i].object.id +
	            "due to " + error.errors[i].message);
	        }
	      } else {
	        console.log("Delete aborted because of " + error.message);
	      }
	      
		throw new Error("Error: " + error.code + " " + error.message);
	}).then(function(objectList) {
		// all the new GCUR_ADJUST_LOCATION objects were saved.
		var newAdjustLocationIds = [];
		
		for (var y = 0; y < objectList.length; y ++) {
			newAdjustLocationIds.push(objectList[y].id);
		}
		
		var createdAdjustLocationIds = {
			"createdAdjustLocationIds": newAdjustLocationIds
		};
		
		return createdAdjustLocationIds;
	}, function(error) {
		throw new Error("Error: " + error.code + " " + error.message);
	});
});

/**
 * Finalise all data on the Parse.com side. This function is called in FinaliseModel python script
 * - Finalise GCUR_OBSERVATION class
 * - Finalise GCUR_ADJUST_DISTRICT class
 * - Finalise GCUR_ADJUST_LOCATION class
 */
Parse.Cloud.define("finaliseDataOnParse", (request) => {
	var result = false;
	
	console.log("Triggering the Cloud Function 'finaliseDataOnParse'");
	
	// Change all GCUR_OBSERVATION records with ObservationStatus being 1 to 2
	queryPrev = new Parse.Query("GCUR_OBSERVATION");
	queryPrev.equalTo("ObservationStatus", 1);
	queryPrev.limit(1000);
	return queryPrev.find().then(function(prev_observations) {
		//return Parse.Object.destroyAll(prev_observations);
		for (var i = 0; i < prev_observations.length; i ++) {
			var obs = prev_observations[i];
			obs.set("ObservationStatus", 2);
		}
		
		return Parse.Object.saveAll(prev_observations, { useMasterKey: true });
	}).then(function() {
		console.log("All GCUR_OBSERVATION records with ObservationStatus being 1 have been succssfully changed to archived observations.");
		
		// Find all current GCUR_OBSERVATION records with ObservationStatus being 0
		queryCurr = new Parse.Query("GCUR_OBSERVATION");
		queryCurr.equalTo("ObservationStatus", 0);
		queryCurr.limit(1000);
		return queryCurr.find();
	}).then(function(curr_observations) {
		for (var i = 0; i < curr_observations.length; i ++) {
			var obs = curr_observations[i];
			
			// Set current to previous
			obs.set("ObservationStatus", 1);
			
			// Set finalisedDate
			var currDateTime = new Date();
			obs.set("FinalisedDate", currDateTime);
		}
		return Parse.Object.saveAll(curr_observations, { useMasterKey: true });
	}).then(function(list) {
		// All the objects were saved.
		console.log("All current GCUR_OBSERVATION records with ObservationStatus being 0 have been succssfully updated to previous records.");
		
		// Change all GCUR_ADJUST_DISTRICT records with status being 1 to 2
		queryPrev = new Parse.Query("GCUR_ADJUST_DISTRICT");
		queryPrev.equalTo("status", 1);
		queryPrev.limit(1000);
		return queryPrev.find();
	}).then(function(prev_adjustDistricts) {
		for (var i = 0; i < prev_adjustDistricts.length; i ++) {
			var abd = prev_adjustDistricts[i];
			abd.set("status", 2);
		}
		return Parse.Object.saveAll(prev_adjustDistricts, { useMasterKey: true });
	}).then(function() {
		console.log("All GCUR_ADJUST_DISTRICT records with status being 1 have been succssfully changed to archived records.");
		
		// Find all current GCUR_ADJUST_DISTRICT records with status being 0
		queryCurr = new Parse.Query("GCUR_ADJUST_DISTRICT");
		queryCurr.equalTo("status", 0);
		queryCurr.limit(1000);
		return queryCurr.find();
	}).then(function(curr_adjustDistricts) {
		for (var i = 0; i < curr_adjustDistricts.length; i ++) {
			var abd = curr_adjustDistricts[i];
			
			// Set current to previous
			abd.set("status", 1);
		}
		return Parse.Object.saveAll(curr_adjustDistricts, { useMasterKey: true });
	}).then(function(list) {
		console.log("All current GCUR_ADJUST_DISTRICT records with ObservationStatus being 0 have been succssfully updated to previous records.");
		
		// Change all GCUR_ADJUST_LOCATION records with status being 1 to 2
		queryPrev = new Parse.Query("GCUR_ADJUST_LOCATION");
		queryPrev.equalTo("status", 1);
		queryPrev.limit(1000);
		return queryPrev.find();
	}).then(function(prev_adjustLocations) {
		for (var i = 0; i < prev_adjustLocations.length; i ++) {
			var abl = prev_adjustLocations[i];
			abl.set("status", 2);
		}
		return Parse.Object.saveAll(prev_adjustLocations, { useMasterKey: true });
	}).then(function() {
		console.log("All GCUR_ADJUST_LOCATION records with status being 1 have been succssfully changed to archived records.");
		
		// Find all current GCUR_ADJUST_LOCATION records with status being 0
		queryCurr = new Parse.Query("GCUR_ADJUST_LOCATION");
		queryCurr.equalTo("status", 0);
		queryCurr.limit(1000);
		return queryCurr.find();
	}).then(function(curr_adjustLocations) {
		for (var i = 0; i < curr_adjustLocations.length; i ++) {
			var abl = curr_adjustLocations[i];
			
			// Set current to previous
			abl.set("status", 1);
		}
		return Parse.Object.saveAll(curr_adjustLocations, { useMasterKey: true });
	}).then(function(list) {
		// All the objects were saved.
		console.log("All current GCUR_ADJUST_LOCATION records with ObservationStatus being 0 have been succssfully updated to previous records.");
		
		result = true;
		return result;  //saveAll is now finished and we can properly exit with confidence :-)
	}, function(error) {
		throw new Error("Error: " + error.code + " " + error.message);
	});
});

/**
 * Retrieve all Finalise Date based on the "updatedAt" column of the GCUR_FINALISEMODEL class
 */
Parse.Cloud.define("getAllFinalisedDate", (request) => {
	var finaliseModelList = [];
	
	// Get the "createdAt" column
	var queryFinaliseModel = new Parse.Query("GCUR_FINALISEMODEL");
	queryFinaliseModel.ascending("createdAt");
	queryFinaliseModel.equalTo("jobResult", true);
	queryFinaliseModel.select("jobResult");
	queryFinaliseModel.limit(1000);
	
	return queryFinaliseModel.find().then(function(results) {
		for (var i = 0; i < results.length; i ++) {
			var finaliseModel = results[i];
			
			var jobResult = finaliseModel.get("jobResult");
			var jobId = finaliseModel.id;
			var createdDate = finaliseModel.createdAt;
			
			var finaliseModelObj = {
					"jobId": jobId,
					"jobResult": jobResult,
					"createdDate": createdDate
			};
			
			finaliseModelList.push(finaliseModelObj);
		}
	}).then(function() {
	    return finaliseModelList;
	}, function(error) {
		throw new Error("Error: " + error.code + " " + error.message);
	});
});

/**
 * Get the downloadable observation report based on user-specified finalised model objectId
 */
Parse.Cloud.define("getDataReport", (request) => {
	var finalisedModelObjectId = request.params.finalisedModelObjectId;
	
	var returnedObsList = [];
	
	var promise = undefined;
	var flagExportCurrObs = "Export current observations";
	
	if (finalisedModelObjectId == "-9999") {
		console.log("*** To export current observations at this point of time.");
		promise = Promise.resolve(flagExportCurrObs);
	} else {
		//console.log("*** To export previous finalised observations.");
		var queryFinaliseModel = new Parse.Query("GCUR_FINALISEMODEL");
		queryFinaliseModel.equalTo("objectId", finalisedModelObjectId);
		queryFinaliseModel.limit(1000);
		promise = queryFinaliseModel.first();
	}
	
	return promise.then(function(val)  {
		var queryObservation = new Parse.Query("GCUR_OBSERVATION");
		
		// Export current obs
		if (val == flagExportCurrObs) {
			
			queryObservation.equalTo("ObservationStatus", 0);			// Current week's observations
			queryObservation.include("Location");
			queryObservation.include("RateOfDrying");
			queryObservation.limit(1000);
			return queryObservation.find();
		
		} else {
			var finalisedModel = val;
			
			var createdAt = finalisedModel.createdAt;
		
			var year = createdAt.getFullYear();
			var month = createdAt.getMonth();
			var date = createdAt.getDate();
			
			// Get all observations with FinalisedDate ranging between startUTC and endUTC time period
			var startUTC = new Date(Date.UTC(year, month, date, 0, 0, 0));
			var endUTC = new Date(Date.UTC(year, month, date, 23, 59, 59));
			
			queryObservation = new Parse.Query("GCUR_OBSERVATION");
			queryObservation.greaterThan("FinalisedDate", startUTC);
			queryObservation.lessThan("FinalisedDate", endUTC);
			queryObservation.include("Location");
			queryObservation.include("RateOfDrying");
			queryObservation.limit(1000);
			return queryObservation.find();
		}
	}).then(function(observations) {
		for (var i = 0; i < observations.length; i ++) {
			var location = undefined;
			var locationName = undefined;
			var lng = undefined;
			var lat = undefined;
			var areaCuring = undefined;
			var validatorCuring = undefined;
			var adminCuring = undefined;
			var fuelContinuity = undefined;
			var fuelQuantity = undefined;
			var userFuelLoad = undefined;
			var validatorFuelLoad = undefined;
			var rainfall = undefined;
			var rateOfDrying = undefined;
			var comments = undefined;
			
			location = observations[i].get("Location");
			locationName = location.get("LocationName");
			lng = location.get("Lng");
			lat = location.get("Lat");
			
			var observationStatus = observations[i].get("ObservationStatus");
			
			if (observations[i].has("AreaCuring"))
				areaCuring = observations[i].get("AreaCuring");
			if (observations[i].has("ValidatorCuring"))
				validatorCuring = observations[i].get("ValidatorCuring");
			if (observations[i].has("AdminCuring"))
				adminCuring = observations[i].get("AdminCuring");
			if (observations[i].has("FuelContinuity"))
				fuelContinuity = observations[i].get("FuelContinuity");
			if (observations[i].has("FuelQuantity"))
				fuelQuantity = observations[i].get("FuelQuantity");
			if (observations[i].has("UserFuelLoad"))
				userFuelLoad = observations[i].get("UserFuelLoad");
			if (observations[i].has("ValidatorFuelLoad"))
				validatorFuelLoad = observations[i].get("ValidatorFuelLoad");
			if (observations[i].has("Rainfall"))
				rainfall =  observations[i].get("Rainfall");
			if (observations[i].has("RateOfDrying"))
				rateOfDrying = observations[i].get("RateOfDrying").get("rateOfDrying");
			if (observations[i].has("Comments"))
				comments = observations[i].get("Comments");
			
			var returnedObs = {
					"locationName": locationName,
					"lng": lng,
					"lat": lat,
					"areaCuring": areaCuring,
					"validatorCuring": validatorCuring,
					"adminCuring": adminCuring,
					"fuelContinuity": fuelContinuity,
					"fuelQuantity": fuelQuantity,
					"userFuelLoad": userFuelLoad,
					"validatorFuelLoad": validatorFuelLoad,
					"rainfall": rainfall,
					"rateOfDrying": rateOfDrying,
					"comments": comments,
					"observationStatus": observationStatus
			};
			returnedObsList.push(returnedObs);
		}
		
	    return returnedObsList;
	}, function(error) {
		throw new Error("Error: " + error.code + " " + error.message);
	});
});

/**
 * Retrieve the detail about a FinaliseModel object by its input objectId
 * Called by adminTools.jsp action=RefreshIncompleteFinaliseModelJobDetailsByAjax&objectId=
 */
Parse.Cloud.define("getFinaliseModelDetail", (request) => {
	var inFinaliseModelObjId = null;
	
	//console.log("Getting FinaliseModel Detail for ObjectId [" + request.params.finaliseModelObjId + "]");
	inFinaliseModelObjId = request.params.finaliseModelObjId;
	
	// Query GCUR_FINALISEMODEL class
	var queryFinaliseModel = new Parse.Query("GCUR_FINALISEMODEL");
	queryFinaliseModel.equalTo("objectId", inFinaliseModelObjId);
	queryFinaliseModel.include("submittedBy");	// Retrieve _USER
	queryFinaliseModel.limit(1000);
	return queryFinaliseModel.first({ useMasterKey: true }).then(function(finaliseModelJob) {
		var jobDetail = {};
		
		if (finaliseModelJob != undefined) {
			var objectId = finaliseModelJob.id;
			var createdAt = finaliseModelJob.createdAt;
			var updatedAt = finaliseModelJob.updatedAt;
			var jobResult = finaliseModelJob.get("jobResult");
			var jobResultDetails = finaliseModelJob.get("jobResultDetails");
			var status = finaliseModelJob.get("status");
			var viscaMapFile = finaliseModelJob.get("viscaMapFile");
				
			var submittedBy = finaliseModelJob.get("submittedBy");
			var userObjId = submittedBy.id;
			var firstname = submittedBy.get("firstName");
			var lastname = submittedBy.get("lastName");
		        
			jobDetail = {
		    		"objectId" : objectId,
		        	"createdAt" : createdAt,
		        	"updatedAt" : updatedAt,
		        	"jobResult" : jobResult,
		        	"jobResultDetails" : jobResultDetails,
		        	"status" : status,
		        	"viscaMapFile" : viscaMapFile,
		        	"submittedByUserOID" : userObjId,
		        	"submittedByUserFullName" : firstname + " " + lastname
		    };
		}
		
		return jobDetail;
	}, function(error) {
		throw new Error("Error: " + error.code + " " + error.message);
	});
});

/**
 * Apply Validation By Exception if previous best curing reached 100%
 * Triggered by the applyValidationByException function in \NEMP_GC\Parse_synch\NSW_New_Mig\synch.py
 */
Parse.Cloud.define("applyValidationByException", (request) => {
	var startTime = new Date().getTime();
	
	var isValidationByException = false;
	var countOfObsApplied = 0;
	
	// Check if the system setting "isValidationByException " is currently set "True";
	var querySystemSettings = new Parse.Query("GCUR_SYSTEM_SETTINGS");
	return querySystemSettings.first().then(function(systemSettingRecord) {
		try {
			isValidationByException = systemSettingRecord.get("isValidationByException");
			return Promise.resolve("isValidationByException is found!");
		} catch (err) {
			console.log("There was an error in getting 'isValidationByException'.");
			return Promise.reject("There was an error in getting 'isValidationByException'.");
		}
	}, function(error) {
		console.log("There was an error in finding GCUR_SYSTEM_SETTINGS.");
		return Promise.reject("There was an error in finding GCUR_SYSTEM_SETTINGS.");
	}).then(function() {
		console.log("isValidationByException = " + isValidationByException);
		
		if (isValidationByException) {
			return Promise.resolve("To apply Validation By Exception rule!");
		} else {
			console.log("Not to applying Validation By Exception rule. Function stopped here.");
			return Promise.reject("Validation By Exception is currently set False.");
		}
	}).then(function() {
		console.log("Applying Validation By Exception rule... ...");
		
		// retrieve previous and current observations
		var queryObservation = new Parse.Query("GCUR_OBSERVATION");
		queryObservation.include("Location");
		queryObservation.include("Observer");
		queryObservation.include("Validator");
		queryObservation.include("Administrator");
		queryObservation.limit(1000);
		queryObservation.notEqualTo("ObservationStatus", 2);	// only includes previous and current observations
		queryObservation.ascending("ObservationStatus");		// 0 - current; 1 - previous
		return queryObservation.find({ useMasterKey: true });
	}).then(function(results) {
		// results are JavaScript Array of GCUR_OBSERVATION objects for both current and previous weeks;
		
		var prevObsList = [];		// previous GCUR_OBSERVATION object array
		var prevLocIds = [];		// the objectId array for the GCUR_LOCATION objects that exist in previous GCUR_OBSERVATION objects
		var currLocIds = [];		// the objectId array for the GCUR_LOCATION objects that exist in current GCUR_OBSERVATION objects
		var prevLocsOnlyIds = [];	// the objectId array for the GCUR_LOCATION objects exist in previous GCUR_OBSERVATION objects ONLY
		
		for (var i = 0; i < results.length; i++) {
			var obsStatus = results[i].get("ObservationStatus");
			var locObjId = results[i].get("Location").id;
			
			if (results[i].get("ObservationStatus") == 1) {
				
				// check if FinalisedDate is 30 days away
				var isPrevObsTooOld = isObsTooOld(results[i].get("FinalisedDate"));
				if (!isPrevObsTooOld) {
					prevObsList.push(results[i]);
					prevLocIds.push(locObjId);
				}
			} else {
				currLocIds.push(locObjId);
			}
		}
		
		prevLocsOnlyIds = inAButNotInB(prevLocIds, currLocIds);
		console.log(prevLocsOnlyIds.length + " locations that do not exist in current week but in previous week.");
		
		var currObsListToBeSaved = [];	// array for the GCUR_OBSERVATION objects to be saved to the GCUR_OBSERVATION table by the rule!

		for (var j = 0; j < prevLocsOnlyIds.length; j++) {			
			for (var k = 0; k < prevObsList.length; k++) {
				var prevObs = prevObsList[k];
				
				// We only care about locations that were observed in previous week but not the current week!!!
				if (prevLocsOnlyIds[j] == prevObs.get("Location").id) {
					// if does not exist, it is "undefined"
					var isToAdd = false;	// a boolean variable to indicate whether to add this GCUR_OBSERVATION object to the class
					
					var GCUR_OBSERVATION = Parse.Object.extend("GCUR_OBSERVATION");
					var currObs = new GCUR_OBSERVATION();	// a current GCUR_OBSERVATION object to be saved
					
					// Calcuate the previous best curing
					var prevOpsCuring;
					if (prevObs.has("AdminCuring")) {
						prevOpsCuring = prevObs.get("AdminCuring");
					} else if (prevObs.has("ValidatorCuring")) {
						prevOpsCuring = prevObs.get("ValidatorCuring");
					} else {
						prevOpsCuring = prevObs.get("AreaCuring");
					}
					
					// if previous best curing was not 100, do not apply automated curing
					if (prevOpsCuring != 100)
						isToAdd = false;
					else {
						isToAdd = true;
						
						// if previous AdminCuring was 100, copy to the current week GCUR_OBSERVATION record
						if (prevObs.has("AdminCuring")) {
							currObs.set("AdminCuring", prevObs.get("AdminCuring"));
							currObs.set("Administrator", prevObs.get("Administrator"));
							currObs.set("AdminDate", prevObs.get("AdminDate"));
						}
						
						// if previous ValidatorCuring exists and was 100
						if (prevObs.has("ValidatorCuring") && (prevObs.get("ValidatorCuring") == 100)) {
							currObs.set("ValidatorCuring", prevObs.get("ValidatorCuring"));
							currObs.set("Validator", prevObs.get("Validator"));
							currObs.set("ValidationDate", prevObs.get("ValidationDate"));
						}
						
						// if previous AreaCuring exists and was 100
						if (prevObs.has("AreaCuring") && (prevObs.get("AreaCuring") == 100)) {
							currObs.set("AreaCuring", prevObs.get("AreaCuring"));
							currObs.set("Observer", prevObs.get("Observer"));
							currObs.set("ObservationDate", prevObs.get("ObservationDate"));
						}
					}
					
					// add this current GCUR_OBSERVATION object to the array to be saved to the GCUR_OBSERVATION class
					if (isToAdd) {
						var location = prevObs.get("Location");
						var locationName = location.get("LocationName")
						
						currObs.set("Location", location);
						currObs.set("ObservationStatus", 0);
						currObs.set("Comments", "AutomatedValidation rule applied");
						
						currObsListToBeSaved.push(currObs);
						countOfObsApplied++;
						console.log("** Appending No. " + countOfObsApplied + " GCUR_OBSERVATION with GCUR_LOCATION objectId: " + location.id + " (" + locationName + ") from previous GCUR_OBSERVATION objectId: " + prevObs.id);
					}
					
					// remove this previous obs from the prevObsList to reduce the iteration count for the next loop
					var index = prevObsList.indexOf(prevObs);	// <-- Not supported in <IE9
					if (index !== -1) {
						prevObsList.splice(index, 1);
					}
					
					break;
				}
			}
		}
		
		return Parse.Object.saveAll(currObsListToBeSaved, { useMasterKey: true });
	}).then(function(objectList) {
		// all the objects were saved.
		var createdNewObsIds = [];
		
		for (var y = 0; y < objectList.length; y ++) {
			createdNewObsIds.push(objectList[y].id);
		}
		
		var createdNewObsIdList = {
		    "createdNewObsIds": createdNewObsIds
		};
		
		console.log("Validation By Exception rule applied; New GCUR_OBSERVATION object count = " + countOfObsApplied);
		console.log("The execution time for 'applyValidationByException' = " + (new Date().getTime() - startTime)/1000);
		
		return createdNewObsIdList;
	}, function(error) {
		throw new Parse.Error(1001, 'Error on applyValidationByException: ' + error.toString());
	});
});

/**
 * Automate RunModel by adding a RunModel given defined creteria.
 * Triggered by automated_run_model.py
*/
Parse.Cloud.define("automateRunModel", (request) => {
	var executionResult = false;
	var executionMsg = "";
	var isJobAdded = false;

	var ToCreate = false;
	var ResToCreate = "";
	
	console.log("Triggering the Cloud Function 'automateRunModel'");
	
	// Get the parameters for startUTC and endUTC time period
	var nowDt = new Date(new Date().toUTCString());
	var today_utc_ts =  Date.UTC(nowDt.getUTCFullYear(), nowDt.getUTCMonth(), nowDt.getUTCDate(), 0, 0, 0);
	var greaterThanDt = new Date(today_utc_ts);
	//console.log("Today starting at " + greaterThanDt);
	
	var queryRunModel = new Parse.Query("GCUR_RUNMODEL");
	queryRunModel.greaterThan("createdAt", greaterThanDt);
	return queryRunModel.find().then(function(results) {
		
		switch (results.length) {
		
			// If no RunModel job has been added
			case 0:
				executionMsg += "No RunModel job was added. "
				console.log(executionMsg);
				
				ToCreate = true;
				ResToCreate = RESOLUTIONS[0];
				break;
			// If there is 1 RunModel job that has been added
			case 1:
				// If it has been completed
				executionMsg += "One RunModel job was added. "
				console.log(executionMsg);
				
				if (results[0].get("status") == 2) {
					// If it has been also failed
					if (results[0].get("jobResult") == false) {
						executionMsg += "status is Completed. jobResult was false. "
						console.log(executionMsg);
						
						ToCreate = true;
						ResToCreate = results[0].get("resolution");;
					}
					// If it has been also successful
					else {
						executionMsg += "status is Completed. jobResult was true. "
						console.log(executionMsg);
						
						ToCreate = true;
						currRes = results[0].get("resolution");
						ResToCreate = RESOLUTIONS.find(function(element) {
							return element != currRes;
						});
					}
					
				} else {
					executionMsg += "status is not Complete. So we will wait for this job to complete. No job to add. "
					console.log(executionMsg);
				}
				
				break; 
			// If there have been more than 2 RunModel jobs added
			default:
				executionMsg += "More than 2 RunModel jobs have been added. "
				console.log(executionMsg);
			
				var isAllJobsCompleted = true;
				
				for (var i = 0; i < results.length; i++) {
					
					// If any of the job was not complete (not started or in progress)
					if (results[i].get("status") != 2) {
						isAllJobsCompleted = false;
						break;
					}
				}
				
				// If all jobs were already complete; we will find out the details.
				if (isAllJobsCompleted) {
					executionMsg += "All RunModel jobs were with status of complete. "
					console.log(executionMsg);
					
					var predefined_rm_obs_list = [];
					
					for (var j = 0; j < RESOLUTIONS.length; j++) {
						var predefined_rm_obs = {
							"resolution" : RESOLUTIONS[j],
							"status" : undefined,
							"jobResult" : undefined,
							"jobResultDetails" : undefined
						}
						
						predefined_rm_obs_list.push(predefined_rm_obs);
					}		
					
					for (var k = 0; k < predefined_rm_obs_list.length; k++) {
						for (var i = 0; i < results.length; i++) {
							if (results[i].get("resolution") == predefined_rm_obs_list[k]['resolution']) {
								if (predefined_rm_obs_list[k]['jobResult'] != true) {
									predefined_rm_obs_list[k]['status'] = results[i].get("status");
									predefined_rm_obs_list[k]['jobResult'] = results[i].get("jobResult");
									predefined_rm_obs_list[k]['jobResultDetails'] = results[i].get("jobResultDetails");
								}
							}
						}
					}
					
					executionMsg += "'" + JSON.stringify(predefined_rm_obs_list) + "' ";
					console.log(executionMsg);
					// Find out whether there is need to create a new RunModel job
					for (var k = 0; k < predefined_rm_obs_list.length; k++) {

						if (predefined_rm_obs_list[k]['status'] != undefined) {
							// If this RunModel job was failed
							if (predefined_rm_obs_list[k]['jobResult'] != true) {
								ToCreate = true;
								ResToCreate = predefined_rm_obs_list[k]['resolution'];
								break;		// We always want to add a new RunModel model for those failed one first
							} else
								console.log(predefined_rm_obs_list[k]['resolution'] + ": " + predefined_rm_obs_list[k]['jobResult']);
						} else {
							ToCreate = true;
							ResToCreate = predefined_rm_obs_list[k]['resolution'];
						}
					}
				} else {
					executionMsg += "There is at least one job with its status being not Complete. So we will wait for this job to complete. "
					console.log(executionMsg);
				}
		}
		
		return Promise.resolve("Current RunModel jobs have been checked. Continue... ...");
	}).then(function() {
		// Save a new RunModel job based on ResToCreate
		if (ToCreate) {
			var GCUR_RUNMODEL = Parse.Object.extend("GCUR_RUNMODEL");
			var newRMJob = new GCUR_RUNMODEL();				// a new GCUR_RUNMODEL object to be saved
			
			// Had to add a fake user ... REQUIRE AMENDMENT!!!
			var admin = new Parse.User();
			admin.id = SUPERUSER_OBJECTID;
			
			return newRMJob.save({
				status: 0,
				resolution: ResToCreate,
				jobResult: false,
				submittedBy: admin
			}, { useMasterKey: true });
			
			
			/*
			{
				useMasterKey: true,
			
				success: function(obj) {
					// The save was successful.
					isJobAdded = true;
					executionMsg += "A new RunModel job with resolution of " + ResToCreate + " has been successfully saved. "
					console.log(executionMsg);
					response.success({"ToCreate": ToCreate, "ResToCreate": ResToCreate, 'executionMsg': executionMsg, 'isJobAdded': isJobAdded});
				},
				
				error: function(successful, error) {
					// The save failed.  Error is an instance of Parse.Error.
					executionMsg += "There was an error in saving a new RunModel job with resolution of " + ResToCreate;
					console.log(executionMsg);
					response.error({"ToCreate": ToCreate, "ResToCreate": ResToCreate, 'executionMsg': executionMsg, 'isJobAdded': isJobAdded});
				}
			});
			*/
		} else
			//response.success({"ToCreate": ToCreate, "ResToCreate": ResToCreate, 'executionMsg': executionMsg, 'isJobAdded': isJobAdded});
			return Promise.resolve({"ToCreate": ToCreate, "ResToCreate": ResToCreate, 'executionMsg': executionMsg, 'isJobAdded': isJobAdded});		
	}).then(function(obj) {
		// The save was successful.
		isJobAdded = true;
		executionMsg += "A new RunModel job with resolution of " + ResToCreate + " has been successfully saved. "
		console.log(executionMsg);
		return {"ToCreate": ToCreate, "ResToCreate": ResToCreate, 'executionMsg': executionMsg, 'isJobAdded': isJobAdded};
	}, function(error) {
		// The save failed.  Error is an instance of Parse.Error.
		executionMsg += "There was an error in saving a new RunModel job with resolution of " + ResToCreate;
		console.log(executionMsg);
		throw new Parse.Error(1001, {"ToCreate": ToCreate, "ResToCreate": ResToCreate, 'executionMsg': executionMsg, 'isJobAdded': isJobAdded});
	});
});

/**
 * Automate FinaliseData by adding a FinaliseData given defined creteria.
 * Triggered by automated_finalise_data.py
 */
Parse.Cloud.define("automateFinaliseData", (request) => {
	var executionResult = false;
	var executionMsg = "";
	var isJobAdded = false;

	var isRunModelsSuccessful = false;
	var ToCreate = false;
	
	console.log("Triggering the Cloud Function 'automateFinaliseData'");
	
	// Get the parameters for startUTC and endUTC time period
	var nowDt = new Date(new Date().toUTCString());
	var today_utc_ts =  Date.UTC(nowDt.getUTCFullYear(), nowDt.getUTCMonth(), nowDt.getUTCDate(), 0, 0, 0);
	var greaterThanDt = new Date(today_utc_ts);
	console.log("Today starting at " + greaterThanDt);
	
	// Query the GCUR_RUNMODEL table to find out if the RunModel jobs for both resolutions have been successfully run
	// This is for double check to be more secure that we are not adding a FinaliseData job if RunModels were not successful.
	var queryRunModel = new Parse.Query("GCUR_RUNMODEL");
	queryRunModel.greaterThan("createdAt", greaterThanDt);
	return queryRunModel.find().then(function(results) {
		
		switch (results.length) {
		
			// If no RunModel job has been added
			case 0:
				executionMsg += "No RunModel job was added. FinaliseData job will not be added. ";
				console.log(executionMsg);

				break;
				
			// If there is 1 RunModel job that has been added
			case 1:
				// If it has been completed
				executionMsg += "One RunModel job was added. FinaliseData job will not be added. ";
				console.log(executionMsg);
				
				break;
			
			// If there have been more than 2 RunModel jobs added
			default:
				executionMsg += "More than 2 RunModel jobs have been added. "
				console.log(executionMsg);
			
				var isAllJobsCompleted = true;
				
				for (var i = 0; i < results.length; i++) {
					
					// If any of the job was not complete (not started or in progress)
					if (results[i].get("status") != 2) {
						isAllJobsCompleted = false;
						break;
					}
				}
				
				// If all jobs were already complete; we will find out the details.
				if (isAllJobsCompleted) {
					executionMsg += "All RunModel jobs were with status of complete. "
					console.log(executionMsg);
					
					var predefined_rm_obs_list = [];
					
					for (var j = 0; j < RESOLUTIONS.length; j++) {
						var predefined_rm_obs = {
							"resolution" : RESOLUTIONS[j],
							"status" : undefined,
							"jobResult" : undefined,
							"jobResultDetails" : undefined
						}
						
						predefined_rm_obs_list.push(predefined_rm_obs);
					}		
					
					for (var k = 0; k < predefined_rm_obs_list.length; k++) {
						for (var i = 0; i < results.length; i++) {
							if (results[i].get("resolution") == predefined_rm_obs_list[k]['resolution']) {
								if (predefined_rm_obs_list[k]['jobResult'] != true) {
									predefined_rm_obs_list[k]['status'] = results[i].get("status");
									predefined_rm_obs_list[k]['jobResult'] = results[i].get("jobResult");
									predefined_rm_obs_list[k]['jobResultDetails'] = results[i].get("jobResultDetails");
								}
							}
						}
					}
					
					executionMsg += "'" + JSON.stringify(predefined_rm_obs_list) + "' ";
					console.log(executionMsg);
					
					// Find out whether RunModel jobs for both resolutions were already successful
					isRunModelsSuccessful = predefined_rm_obs_list.every(function(rm) {
						return (rm['status'] == 2) && (rm['jobResult'] == true);
					});
					
				} else {
					executionMsg += "There is at least one RunModel job with its status being 'not Complete'. So we will wait for this job to complete. "
					console.log(executionMsg);
				}
		}
		
		executionMsg += ". isRunModelsSuccessful = " + isRunModelsSuccessful + ". ";
		console.log(executionMsg);
		
		if (isRunModelsSuccessful) {
			return Promise.resolve("isRunModelsSuccessful is true!");
		} else {
			return Promise.reject("isRunModelsSuccessful is false!");	// Go straight to the error callback at the end
		}		
	}).then(function() {	
		var queryFinaliseData = new Parse.Query("GCUR_FINALISEMODEL");
		queryFinaliseData.greaterThan("createdAt", greaterThanDt);
		return queryFinaliseData.find();
	}).then(function(results) {			
		switch (results.length) {
			
				// If no FinaliseData job has been added
				case 0:
					executionMsg += "No FinaliseData job was added. "
					console.log(executionMsg);
					
					ToCreate = true;
					break;
				// If there is 1 FinaliseData job that has been added
				case 1:
					// If it has been completed
					executionMsg += "One FinaliseData job was already added. "
					console.log(executionMsg);
					
					if (results[0].get("status") == 2) {
						// If it has been also failed
						if (results[0].get("jobResult") == false) {
							executionMsg += "status is Completed. jobResult was false. No FinaliseData job to add. "
							console.log(executionMsg);
						}
						// If it has been also successful
						else {
							executionMsg += "status is Completed. jobResult was true. No FinaliseData job to add. "
							console.log(executionMsg);
						}
						
					} else {
						executionMsg += "status is not Complete. So we will wait for this FinaliseData job to complete. No job to add. "
						console.log(executionMsg);
					}
					
					break; 
				// If there have been more than 2 FinaliseData jobs added
				default:
					executionMsg += "More than 2 FinaliseData jobs have been added. No FinaliseData job to add. "
					console.log(executionMsg);
		}
			
		return Promise.resolve("Current FinaliseData jobs have been checked. Continue... ...");		
	}).then(function() {
		// Save a new FinalisedData job based on ResToCreate
		if (ToCreate) {
			var GCUR_FINALISEMODEL = Parse.Object.extend("GCUR_FINALISEMODEL");
			var newFDJob = new GCUR_FINALISEMODEL();				// a new GCUR_FINALISEMODEL object to be saved
			
			// Had to add a fake user ... REQUIRE AMENDMENT!!!
			var admin = new Parse.User();
			admin.id = SUPERUSER_OBJECTID;
			
			return newFDJob.save({
				status: 0,
				jobResult: false,
				submittedBy: admin
			}, { useMasterKey: true });


				/*
			
				success: function(obj) {
					// The save was successful.
					isJobAdded = true;
					executionMsg += "A new FinalisedData job has been successfully saved. "
					console.log(executionMsg);
					response.success({"ToCreate": ToCreate, 'executionMsg': executionMsg, 'isJobAdded': isJobAdded});
				},
				
				error: function(successful, error) {
					// The save failed.  Error is an instance of Parse.Error.
					executionMsg += "There was an error in saving a new FinalisedData job. ";
					console.log(executionMsg);
					response.error({"ToCreate": ToCreate, 'executionMsg': executionMsg, 'isJobAdded': isJobAdded, 'error': error});
				}
				*/
			
		} else
			return Promise.resolve({"ToCreate": ToCreate, 'executionMsg': executionMsg, 'isJobAdded': isJobAdded});
	}).then(function(obj) {
		// The save was successful.
		isJobAdded = true;
		executionMsg += "A new FinalisedData job has been successfully saved. "
		console.log(executionMsg);
		return {"ToCreate": ToCreate, 'executionMsg': executionMsg, 'isJobAdded': isJobAdded};
	}, function(error) {
		throw new Parse.Error(1001, {"ToCreate": ToCreate, 'executionMsg': executionMsg, 'isJobAdded': isJobAdded, 'error': error});
	});
});

/**
 * An Underscore utility function to find elements in array that are not in another array;
 * used in the cloud function "applyValidationByException"
 */
function inAButNotInB(A, B) {
	return _.filter(A, function (a) {
		return !_.contains(B, a);
	});
}

/********
* Array utility functions
********/
Array.prototype.contains = function (obj) {
    for (var i = 0; i < this.length; i++) {
        if (this[i] === obj) {
            return true;
        }
    }
    return false;
}

Array.prototype.each = function(fn){
    fn = fn || Function.K;
     var a = [];
     var args = Array.prototype.slice.call(arguments, 1);
     for(var i = 0; i < this.length; i++){
         var res = fn.apply(this,[this[i],i].concat(args));
         if(res != null) a.push(res);
     }
     return a;
};

Array.prototype.uniquelize = function(){
     var ra = new Array();
     for(var i = 0; i < this.length; i ++){
         if(!ra.contains(this[i])){
            ra.push(this[i]);
         }
     }
     return ra;
};

Array.complement = function(a, b){
     return Array.minus(Array.union(a, b),Array.intersect(a, b));
};

Array.intersect = function(a, b){
     return a.uniquelize().each(function(o){return b.contains(o) ? o : null});
};

Array.minus = function(a, b){
     return a.uniquelize().each(function(o){return b.contains(o) ? null : o});
};

Array.union = function(a, b){
     return a.concat(b).uniquelize();
};

/**
 * Returns the last day of the a year and a month
 * e.g. getLastDayOfMonth(2009, 9) returns 30;
 */
function getLastDayOfMonth(Year, Month) {
	var newD = new Date( (new Date(Year, Month,1))-1 );
    return newD.getDate();
}

/**
 * Returns a description of the current date in AEST
 * Parameters:
 * - isDLS: boolean; indicates if it is currently Daylight Saving Time.
 */
function getTodayString(isDLS) {
	var today = new Date();	// ALWAYS IN UTC TIME
	// NOTE: this is to initialize a JS date object in the timezone of the computer/server the function is called.
	// So this is UTC time. There are 10 (11) hrs difference between UTC time and Australian Eastern Standard Time (Daylight Saving Time).
	
	var dd = today.getDate();
	var mm = today.getMonth() + 1;	//January is 0!
	var yyyy = today.getFullYear();
	var hr = today.getHours();	// from 0 - 23!
	
	var lastDayOfTheMonth = getLastDayOfMonth(yyyy, mm);
	
	// is DayLight Saving enabled
	if (isDLS) {
		if (hr>=13)	// "13" hr in UTC is equivalent to "00" hr in AEST the next day!
			dd = dd + 1;
	} else {
		if (hr>=14)	// "14" hr in UTC is equivalent to "00" hr in AEST the next day!
			dd = dd + 1;
	}
	
	// fix the cross-month issue
	if (dd > lastDayOfTheMonth) {
		dd = 1;	// first day of next month
		mm = mm + 1;	// next month
	}
	
	// fix the cross-year issue
	if (mm > 12) {
		mm = 1;
		yyyy = yyyy + 1;
	}
	
	if(dd<10)
		dd = '0' + dd

	if(mm<10)
		mm = '0' + mm

	var strToday = dd + '/' + mm + '/' + yyyy;
	
	return strToday;
}

/*
 * Sort the Array of JSON by the value of a key/field in the JSON
 */
var sort_by = function(field, reverse, primer){
	var key = primer ? function(x) {return primer(x[field])} : function(x) {return x[field]};

	reverse = !reverse ? 1 : -1;

	return function (a, b) {
		return a = key(a), b = key(b), reverse * ((a > b) - (b > a));
	} 
}

/*********************************************************************************************************************************************/
/**
 * Returns number of days between two Date objects
 */
function numDaysBetween(d1, d2) {
	var diff = Math.abs(d1.getTime() - d2.getTime());
	return diff / (1000 * 60 * 60 * 24);
};

/**
 * Returns a boolean if a previous obs (ObservationStatus = 1) is _MAX_DAYS_ALLOWED_FOR_PREVIOUS_OBS days older than Today.
 */
function isObsTooOld(finalisedDate) {
	var today = new Date();
	var numberOfDaysBetween = numDaysBetween(today, finalisedDate);
	
	if (numberOfDaysBetween > _MAX_DAYS_ALLOWED_FOR_PREVIOUS_OBS)
		return true;
	else
		return false;
}
/*********************************************************************************************************************************************/