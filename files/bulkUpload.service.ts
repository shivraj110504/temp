const axios = require("axios");
const { setLog } = require("../utils/logger");
const BulkUploadDao = require("../dao/bulkUploadDao");
const bulkUploadDao = new BulkUploadDao();
const logName = "bulkUploadService";
const { XMLParser, XMLBuilder } = require("fast-xml-parser");
require("dotenv-safe").config();
const Client = require("ssh2-sftp-client");
const fs = require("fs");

const username = process.env.API_USERNAME;
const password = process.env.API_PASSWORD;
const EventEmitter = require("events");
const emitter = new EventEmitter();
const config = {
  host: process.env.SFTP_HOST,
  port: process.env.SFTP_PORT,
  username: process.env.SFTP_USER,
  password: process.env.SFTP_PASS,
};
const sftpFolder = process.env.SFTP_FOLDER;

const relocateFiles = async (reqId) => {
  try {
    setLog("info", reqId, logName, "relocateFiles", {});
    const filesObj = { successFiles: {}, errorFiles: {} };
    const sftp = new Client();
    await sftp
      .connect(config)
      .then(async () => {
        const successFileData = await bulkUploadDao.findRecords({
          raw: true,
          attributes: ["fileName", "folderName"],
          where: {
            attachmentStatus: "SUCCEEDED",
            fileDeleted: null,
          },
        });
        for (const fileDetails of successFileData) {
          const file = fileDetails.fileName;
          const folder = fileDetails.folderName;
          const sourcePath = `${__dirname}/../files/${folder}/${file}`;
          const destinationPath = `${sftpFolder}/Success_Files/${folder}/${file}`;
          await sftp.put(sourcePath, destinationPath);
          await sftp.delete(`${sftpFolder}/${folder}/${file}`);
          await fs.unlink(`files/${folder}/${file}`, async (err) => {
            if (err) {
              setLog(
                "info",
                reqId,
                logName,
                "relocateFiles - File Delete Error",
                {
                  folder,
                  file,
                }
              );
              throw err;
            } else {
              setLog("info", reqId, logName, "relocateFiles - File Deleted", {
                folder,
                file,
              });
              await bulkUploadDao.updateRecordByCondition(
                { fileDeleted: "Y" },
                {
                  fileName: file,
                  attachmentStatus: "SUCCEEDED",
                  fileDeleted: null,
                  folderName: folder,
                }
              );
            }
          });
          filesObj["successFiles"][folder] = filesObj["successFiles"][folder]
            ? filesObj["successFiles"][folder] + 1
            : (filesObj["successFiles"][folder] = 1);
        }
      })
      .then(async () => {
        const failedFilesArr = await bulkUploadDao.findRecords({
          raw: true,
          attributes: ["fileName", "folderName", "reason"],
          where: {
            attachmentStatus: "FAILED",
            fileDeleted: null,
          },
        });
        for (const failedFile of failedFilesArr) {
          const file = failedFile.fileName;
          const folder = failedFile.folderName;
          if (failedFile.reason == "Attachment already uploaded") {
            await sftp.delete(`${sftpFolder}/${folder}/${file}`);
            await bulkUploadDao.updateRecordByCondition(
              { fileDeleted: "Y" },
              {
                fileName: file,
                attachmentStatus: "FAILED",
                fileDeleted: null,
                folderName: folder,
              }
            );
          }

          await fs.unlink(`files/${folder}/${file}`, async (err) => {
            if (err) {
              setLog(
                "info",
                reqId,
                logName,
                "relocateFiles - File Delete Error",
                {
                  folder,
                  file,
                }
              );
              throw err;
            } else {
              setLog("info", reqId, logName, "relocateFiles - File Deleted", {
                folder,
                file,
              });
              await bulkUploadDao.updateRecordByCondition(
                { fileDeleted: "N" },
                {
                  fileName: file,
                  attachmentStatus: "FAILED",
                  fileDeleted: null,
                  folderName: folder,
                }
              );
            }
          });
          filesObj["errorFiles"][folder] = filesObj["errorFiles"][folder]
            ? filesObj["errorFiles"][folder] + 1
            : (filesObj["errorFiles"][folder] = 1);
        }
        sftp.end();
      });

    return filesObj;
  } catch (err) {
    setLog("error", reqId, logName, "relocateFiles", {
      error: err.stack || err.message,
    });
    return false;
  }
};

const makeRequest = (reqId, data) => {
  try {
    setLog("info", reqId, logName, "makeRequest", {});

    const configApi = {
      method: "post",
      url: process.env.API_URL,
      headers: {
        "Content-Type": "text/xml",
      },
      auth: {
        username,
        password,
      },
      data: data,
    };
    return axios(configApi);
  } catch (err) {
    setLog("error", reqId, logName, "makeRequest", {
      error: err.stack || err.message,
    });
  }
};

const generateXml = (reqId, data) => {
  try {
    setLog("info", reqId, logName, "generateXml", {});
    const startXMl = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:typ="http://xmlns.oracle.com/apps/financials/commonModules/shared/model/erpIntegrationService/types/" xmlns:erp="http://xmlns.oracle.com/apps/financials/commonModules/shared/model/erpIntegrationService/">
    <soapenv:Header/>`;
    let xmlBody = `
        <soapenv:Body>
            <typ:uploadAttachment>
                <typ:entityName>AP_INVOICES_ALL</typ:entityName>
                <typ:categoryName>FROM_SUPPLIER</typ:categoryName>
                <typ:allowDuplicate>No</typ:allowDuplicate>
                <!--Zero or more repetitions:-->
                <typ:attachmentRows>
                </typ:attachmentRows>
            </typ:uploadAttachment>
        </soapenv:Body>
    `;
    const endXML = `</soapenv:Envelope>`;

    const parser = new XMLParser();
    xmlBody = parser.parse(xmlBody);

    let attachements = [];
    attachements.push({
      "erp:UserKeyA": "Poonawalla Fincorp Limited BU",
      "erp:UserKeyB": data[0],
      "erp:UserKeyC": data[1],
      "erp:AttachmentType": "File",
      "erp:Title": "Invoice.pdf",
      "erp:Content": data[4],
    });
    xmlBody["soapenv:Body"]["typ:uploadAttachment"]["typ:attachmentRows"] =
      attachements;
    const builder = new XMLBuilder();
    xmlBody = builder.build(xmlBody);
    const result = startXMl + xmlBody + endXML;
    return result;
  } catch (err) {
    setLog("error", reqId, logName, "generateXml", {
      error: err.stack || false,
    });
  }
};

const updateInvoice = async (reqId, data) => {
  try {
    setLog("info", reqId, logName, "updateInvoice", { invoiceNumber: data[0] });
    const body = generateXml(reqId, data);
    const response = await makeRequest(reqId, body);
    const parser = new XMLParser();
    const resultJson = parser.parse(response.data);
    const resultJsonKey = Object.keys(resultJson)[0];
    const reportBytes =
      resultJson[resultJsonKey]["env:Envelope"]["env:Body"][
        "ns0:uploadAttachmentResponse"
      ]["result"];
    const attachmentStatus = JSON.parse(`{${reportBytes}}`)["Attachment1"];
    setLog("info", reqId, logName, "updateInvoice", { attachmentStatus });
    const invoiceObj = {
      invoiceNumber: data[0],
      supplierNumber: data[1],
      invoiceCount: data[2],
      fileName: data[3],
      folderName: data[5],
      attachmentStatus,
    };
    if (attachmentStatus === "SUCCEEDED") {
      invoiceObj.reason = "Upload Successfully";
    } else {
      invoiceObj.reason = "Upload Failed";
    }
    return await bulkUploadDao.createRecord(invoiceObj);
  } catch (err) {
    setLog("error", reqId, logName, "updateInvoice", {
      error: err.message || err.stack,
    });
    return false;
  }
};

const base64decode = async (reqId, pdfPath) => {
  try {
    setLog("info", reqId, logName, "base64decode", { pdfPath });
    const filedata = await fs.readFileSync(pdfPath);
    const base64Data = filedata.toString("base64");
    return base64Data;
  } catch (error) {
    setLog("error", reqId, logName, "base64decode", {
      error: error.message || error.stack,
    });
    return false;
  }
};

const iterateFiles = async (reqId, folderName, files) => {
  try {
    setLog("info", reqId, logName, "iterateFiles", { folderName });
    const pdfFiles = fs
      .readdirSync(`./files/${folderName}/`)
      .filter((file) => file.endsWith(".pdf"));
    const succeededFiles = await bulkUploadDao.findRecords({
      raw: true,
      attributes: ["fileName", "folderName"],
      where: {
        folderName,
        attachmentStatus: "SUCCEEDED",
        fileName: files,
      },
    });

    const succeededFilesArr = await succeededFiles.map(
      (files) => files.fileName
    );

    for (const fileName of pdfFiles) {
      const fileExtension = fileName.split(".");
      const parts = fileExtension[0].split("_");
      let [invoiceNumber, supplierNumber, invoiceCount] = parts;
      const invoiceObj = {
        invoiceNumber,
        supplierNumber,
        invoiceCount,
        fileName,
        folderName,
        attachmentStatus: "FAILED",
      };
      if (succeededFilesArr.includes(fileName)) {
        setLog(
          "error",
          reqId,
          logName,
          "iterateFiles - Attachment already uploaded",
          { folderName, fileName }
        );
        invoiceObj.reason = "Attachment already uploaded";
        await bulkUploadDao.createRecord(invoiceObj);
      } else if (!invoiceNumber || !supplierNumber || !invoiceCount) {
        setLog(
          "error",
          reqId,
          logName,
          "iterateFiles - Missing Required Parameters",
          { folderName, fileName }
        );
        invoiceObj.reason = "Missing Required Parameters";
        await bulkUploadDao.createRecord(invoiceObj);
      } else {
        const invoiceCount =
          parts[2].substring(0, parts[2].indexOf(".")) || parts[2];
        invoiceNumber = invoiceNumber.replace(/&/g, "/");
        const pdfPath = `./files/${folderName}/${fileName}`;
        const decodefiles = await base64decode(reqId, pdfPath);
        const data = [
          invoiceNumber,
          supplierNumber,
          invoiceCount,
          fileName,
          decodefiles,
          folderName,
        ];
        await updateInvoice(reqId, data);
        setLog("info", reqId, logName, "iterateFiles - File Processed", {
          folderName,
          fileName,
        });
      }
    }
    return true;
  } catch (error) {
    setLog("error", reqId, logName, "iterateFiles", {
      error: error.message || error.stack,
    });
    return false;
  }
};

const isEmpty = (obj) => {
  for (const prop in obj) {
    if (Object.hasOwn(obj, prop)) {
      return false;
    }
  }
  return true;
};

const downloadFiles = async (reqId) => {
  try {
    setLog("info", reqId, logName, "downloadFiles", { dirname: __dirname });
    const foldersObj = {};
    let responseObj = {};
    const sftp = new Client();
    await sftp
      .connect(config)
      // snippet in following then will download files locally to process
      .then(async () => {
        setLog("info", reqId, logName, "sftp initiated", {});
        const folders = ["EAG", "BRG", "BAG", "PAG"];
        for (const folderName of folders) {
          const remotePath = `${sftpFolder}/${folderName}`;
          const files = await sftp.list(remotePath);
          const pdfFiles = await files
            .filter((file) => file.name.endsWith(".pdf"))
            .slice(0, 50);
          emitter.setMaxListeners(50); // Listeners added to download large and multiple files
          if (pdfFiles.length > 0) {
            const filesArr = [];
            await Promise.all(
              pdfFiles.map((file) => {
                sftp.get(
                  `${remotePath}/${file.name}`,
                  `${__dirname}/../files/${folderName}/${file.name}`
                );
                filesArr.push(file.name);
              })
            );
            setLog("info", reqId, logName, "files downloaded", {
              folderName,
              files: pdfFiles.length,
            });
            foldersObj[folderName] = filesArr;
          } else {
            setLog(
              "error",
              reqId,
              logName,
              "No Files To Process - downloadFiles",
              {}
            );
            return {
              status: false,
              message: "No Files To Process",
              data: {},
            };
          }
        }
      })
      // snippet in following then will iterate files locally
      .then(async () => {
        setLog("info", reqId, logName, "sftp closed", {});
        if (!isEmpty(foldersObj)) {
          for (const folderName in foldersObj) {
            await iterateFiles(reqId, folderName, foldersObj[folderName]);
          }
        } else {
          setLog(
            "error",
            reqId,
            logName,
            "No Files To Process - iterateFiles",
            {}
          );
          return {
            status: false,
            message: "No Files To Process",
            data: {},
          };
        }
      })
      // snippet in following then will relocate files to ftp
      .then(async () => {
        if (!isEmpty(foldersObj)) {
          const filesRelocated = await relocateFiles(reqId);
          responseObj = {
            status: true,
            message: "Files processed Successfully!",
            data: filesRelocated,
          };
        } else {
          setLog(
            "error",
            reqId,
            logName,
            "No Files To Process - relocateFiles",
            {}
          );
          responseObj = {
            status: false,
            message: "No Files To Process",
            data: {},
          };
        }
      })
      .catch((error) => {
        sftp.end();
        setLog("error", reqId, logName, "catch - sftp closed", {
          error: error.message,
        });
        responseObj = {
          status: false,
          message: "Files process error!",
          data: {},
        };
      })
      .finally(() => sftp.end());
    return responseObj;
  } catch (error) {
    setLog("error", reqId, logName, "downloadFiles", {
      error: error.message || error.stack,
    });
    return {
      status: false,
      message: "Files process error!",
      data: {},
    };
  }
};

const fetchReport = async (req, res) => {
  try {
    setLog("info", req.id, logName, "fetchReport", {});
    const invoiceDetails = await downloadFiles(req.id);
    setLog("info", req.id, logName, "fetchReport", invoiceDetails);
    return invoiceDetails;
  } catch (error) {
    setLog("error", req.id, logName, "fetchReport", {
      error: error.message || error.stack,
    });
    return false;
  }
};

module.exports = { fetchReport };
