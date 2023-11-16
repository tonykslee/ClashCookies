
require("dotenv").config();
import { Client as ClashClient } from 'clashofclans.js';
import * as ko from "knockout";

export class CoCService {
  public isLoggedIn = ko.observable();
  // public cocClient: ClashClient;
  public cocClient = ko.observable();
  
  constructor() {
    // this.cocClient = ko.observable(new ClashClient());
    this.cocClient(new ClashClient());
    this.isLoggedIn(false);
  }

  public login() : Promise<any> {
    console.log("logging into coc api using email: ", process.env.PERSONAL_EMAIL);
    let client : ClashClient = this.cocClient();
    return client.login({ email: process.env.PERSONAL_EMAIL as string, password: process.env.CLASH_API_PASS as string }).then((result) => {
      console.log("successfully connected to Clash Client API. ", result);
      this.isLoggedIn(true);
    }).catch(err => {
      console.log("error occurred while connecting to Clash Client API. ", err);
    });  
  }
}



