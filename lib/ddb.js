// Copyright Teleportd Ltd. and other Contributors
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var http = require('http');
var https = require('https');
var crypto = require('crypto');
var events = require('events');
var Signer = require('./aws-signer');
var fwk = require('fwk');

/**
 * The DynamoDb Object
 *
 * @extends events.EventEmitter
 *
 * @param spec {secretAccessKey, accessKeyId, endpoint, agent, region, sessionToken, sessionExpires}
 */

var ddb = function(spec, my)
{
  my = my ||
  {};
  var _super = {};


  my.accessKeyId = spec.credentials.accessKeyId;
  my.secretAccessKey = spec.credentials.secretAccessKey;
  my.endpoint = spec.endpoint || 'dynamodb.us-east-1.amazonaws.com';
  my.port = spec.port || 80;
  my.agent = spec.agent;

  my.retries = spec.retries || 3;

  // Use already obtained temporary session credentials
  if (spec.sessionToken && spec.sessionExpires)
  {
    my.access = {
      sessionToken: spec.sessionToken,
      secretAccessKey: spec.secretAccessKey,
      accessKeyId: spec.accessKeyId,
      expiration: spec.sessionExpires
    };
  }


  https.globalAgent.maxSockets = spec.maxHttpSockets;
  http.globalAgent.maxSockets = spec.maxHttpSockets;

  my.inAuth = false;
  my.consumedCapacity = 0;
  my.schemaTypes = {
    number: 'N',
    string: 'S',
    number_array: 'NS',
    string_array: 'SS'
  };

  // public
  var createTable;
  var listTables;
  var describeTable;
  var deleteTable;
  var updateTable;

  var getItem;
  var putItem;
  var deleteItem;
  var updateItem;
  var query;
  var scan;
  var batchGetItem;
  var batchWriteItem;

  // private
  var scToDDB;
  var objToDDB;
  var objFromDDB;
  var arrFromDDB;
  var execute;
  var auth;


  var that = new events.EventEmitter();
  that.setMaxListeners(0);


  /**
   * The CreateTable operation adds a new table to your account.
   * It returns details of the table.
   * @param table the name of the table
   * @param keySchema {hash: [attribute, type]} or {hash: [attribute, type], range: [attribute, type]}
   * @param provisionedThroughput {write: X, read: Y}
   * @param cb callback(err, tableDetails) err is set if an error occured
   */
  createTable = function(table, keySchema, provisionedThroughput, cb)
  {
    var data = {};
    data.TableName = table;
    data.KeySchema = {};
    data.ProvisionedThroughput = {};
    if (keySchema.hash && keySchema.hash.length == 2)
    {
      data.KeySchema.HashKeyElement = {
        AttributeName: keySchema.hash[0],
        AttributeType: keySchema.hash[1]
      };
    }
    if (keySchema.range && keySchema.range.length == 2)
    {
      data.KeySchema.RangeKeyElement = {
        AttributeName: keySchema.range[0],
        AttributeType: keySchema.range[1]
      };
    }
    if (provisionedThroughput)
    {
      if (provisionedThroughput.read)
        data.ProvisionedThroughput.ReadCapacityUnits = provisionedThroughput.read;
      if (provisionedThroughput.write)
        data.ProvisionedThroughput.WriteCapacityUnits = provisionedThroughput.write;
    }
    execute('CreateTable', data, function(err, res)
    {
      if (err)
      {
        cb(err)
      }
      else
      {
        cb(null, res.TableDescription);
      }
    });
  };


  /**
   * Updates the provisioned throughput for the given table.
   * It returns details of the table.
   * @param table the name of the table
   * @param provisionedThroughput {write: X, read: Y}
   * @param cb callback(err, tableDetails) err is set if an error occured
   */
  updateTable = function(table, provisionedThroughput, cb)
  {
    var data = {};
    data.TableName = table;
    data.ProvisionedThroughput = {};
    if (provisionedThroughput)
    {
      if (provisionedThroughput.read)
        data.ProvisionedThroughput.ReadCapacityUnits = provisionedThroughput.read;
      if (provisionedThroughput.write)
        data.ProvisionedThroughput.WriteCapacityUnits = provisionedThroughput.write;
    }
    execute('UpdateTable', data, function(err, res)
    {
      if (err)
      {
        cb(err)
      }
      else
      {
        cb(null, res.TableDescription);
      }
    });
  };


  /**
   * The DeleteTable operation deletes a table and all of its items
   * It returns details of the table
   * @param table the name of the table
   * @param cb callback(err, tableDetails) err is set if an error occured
   */
  deleteTable = function(table, cb)
  {
    var data = {};
    data.TableName = table;
    execute('DeleteTable', data, function(err, res)
    {
      if (err)
      {
        cb(err)
      }
      else
      {
        cb(null, res.TableDescription);
      }
    });
  };


  /**
   * returns an array of all the tables associated with the current account and endpoint
   * @param options {limit, exclusiveStartTableName}
   * @param cb callback(err, tables) err is set if an error occured
   */
  listTables = function(options, cb)
  {
    var data = {};
    if (options.limit)
      data.Limit = options.limit;
    if (options.exclusiveStartTableName)
      data.ExclusiveStartTableName = options.exclusiveStartTableName;
    execute('ListTables', data, cb);
  };


  /**
   * returns information about the table, including the current status of the table,
   * the primary key schema and when the table was created
   * @param table the table name
   * @param cb callback(err, tables) err is set if an error occured
   */
  describeTable = function(table, cb)
  {
    var data = {};
    data.TableName = table;
    execute('DescribeTable', data, function(err, res)
    {
      if (err)
      {
        cb(err)
      }
      else
      {
        cb(null, res.Table);
      }
    });
  };


  /**
   * returns a set of Attributes for an item that matches the primary key.
   * @param table the tableName
   * @param hash the hashKey
   * @param range the rangeKey
   * @param options {attributesToGet, consistentRead}
   * @param cb callback(err, tables) err is set if an error occured
   */
  getItem = function(table, keys, options, cb)
  {
    var data = {};
    try
    {
      data.TableName = table;
      data.Key = {};
      for (var i in keys)
      {
        if (keys.hasOwnProperty(i))
        {
          data.Key[i] = scToDDB(keys[i]);
        }
      }
      if (options.attributesToGet)
      {
        data.AttributesToGet = options.attributesToGet;
      }
      if (options.consistentRead)
      {
        data.ConsistentRead = options.consistentRead;
      }
    }
    catch (err)
    {
      cb(err);
      return;
    }
    execute('GetItem', data, function(err, res)
    {
      if (err)
      {
        cb(err)
      }
      else
      {
        my.consumedCapacity += res.ConsumedCapacity.CapacityUnits;
        try
        {
          var item = objFromDDB(res.Item);
        }
        catch (err)
        {
          cb(err);
          return;
        }
        cb(null, item, res.ConsumedCapacity.CapacityUnits);
      }
    });
  };


  /**
   * Creates a new item, or replaces an old item with a new item
   * (including all the attributes). If an item already exists in the
   * specified table with the same primary key, the new item completely
   * replaces the existing item.
   * putItem expects a dictionary (item) containing only strings and numbers
   * This object is automatically converted into the expxected Amazon JSON
   * format for convenience.
   * @param table the tableName
   * @param item the item to put (string/number/string array dictionary)
   * @param options {expected, returnValues}
   * @param cb callback(err, attrs, consumedCapUnits) err is set if an error occured
   */
  putItem = function(table, item, options, cb)
  {
    var data = {};
    try
    {
      data.TableName = table;
      data.Item = objToDDB(item);
      //console.log('ITEM:==' + JSON.stringify(data) + '==');
      if (options.expected)
      {
        data.Expected = {};
        for (var i in options.expected)
        {
          data.Expected[i] = {};
          if (typeof options.expected[i].exists === 'boolean')
          {
            data.Expected[i].Exists = options.expected[i].exists;
          }
          if (typeof options.expected[i].value !== 'undefined')
          {
            data.Expected[i].Value = scToDDB(options.expected[i].value);
          }
        }
      }
      if (options.returnValues)
      {
        data.ReturnValues = options.returnValues;
      }
    }
    catch (err)
    {
      cb(err);
      return;
    }
    execute('PutItem', data, function(err, res)
    {
      if (err)
      {
        cb(err)
      }
      else
      {
        my.consumedCapacity += res.ConsumedCapacity.CapacityUnits;
        try
        {
          var attr = objFromDDB(res.Attributes);
        }
        catch (err)
        {
          cb(err);
          return;
        }
        cb(null, attr, res.ConsumedCapacity.CapacityUnits);
      }
    });
  };


  /**
   * deletes a single item in a table by primary key. You can perform a conditional
   * delete operation that deletes the item if it exists, or if it has an expected
   * attribute value.
   * @param table the tableName
   * @param hash the hashKey
   * @param range the rangeKey
   * @param options {expected, returnValues}
   * @param cb callback(err, attrs, consumedCapUnits) err is set if an error occured
   */
  deleteItem = function(table, keys, options, cb)
  {
    var data = {};
    try
    {
      data.TableName = table;
      data.Key = {};
      for (var i in keys)
      {
        if (keys.hasOwnProperty(i))
        {
          data.Key[i] = scToDDB(keys[i]);
        }
      }
      if (options.expected)
      {
        data.Expected = {};
        for (var i in options.expected)
        {
          data.Expected[i] = {};
          if (typeof options.expected[i].exists === 'boolean')
          {
            data.Expected[i].Exists = options.expected[i].exists;
          }
          if (typeof options.expected[i].value !== 'undefined')
          {
            data.Expected[i].Value = scToDDB(options.expected[i].value);
          }
        }
      }
      if (options.returnValues)
        data.ReturnValues = options.returnValues;
    }
    catch (err)
    {
      cb(err);
      return;
    }
    execute('DeleteItem', data, function(err, res)
    {
      if (err)
      {
        cb(err)
      }
      else
      {
        my.consumedCapacity += res.ConsumedCapacity.CapacityUnits;
        try
        {
          var attr = objFromDDB(res.Attributes);
        }
        catch (err)
        {
          cb(err);
          return;
        }
        cb(null, attr, res.ConsumedCapacity.CapacityUnits);
      }
    });
  };


  /**
   * Updates an item with the supplied update orders.
   * @param table the tableName
   * @param keys the hash key and optional range key
   * @param options {expected, returnValues, updateExpression, attributeUpdates}
   * @param cb callback(err, attrs, consumedCapUnits) err is set if an error occured
   */
  updateItem = function(table, keys, options, cb)
  {
    var data = {};
    try
    {
      data.Key = {};
      for (var i in keys)
      {
        if (keys.hasOwnProperty(i))
        {
          data.Key[i] = scToDDB(keys[i]);
        }
      }
      data.TableName = table;

      if (options.conditionExpression)
      {
        data.ConditionExpression = options.conditionExpression;
      }

      if (options.updateExpression)
      {
        data.UpdateExpression = options.updateExpression;
      }

      if(options.attributeUpdates)
      {
        data.AttributeUpdates = {};
        for (var i in options.attributeUpdates)
        {
          if (options.attributeUpdates.hasOwnProperty(i))
          {
            data.AttributeUpdates[i] = {Action:options.attributeUpdates[i].action, Value:scToDDB(options.attributeUpdates[i].value)};
          }
        }
      }

      if (options.expressionAttributeValues)
      {
        var attr = {};
        for (var i in options.expressionAttributeValues)
        {
          if (options.expressionAttributeValues.hasOwnProperty(i))
          {
            attr[i] = scToDDB(options.expressionAttributeValues[i]);
          }
        }
        data.ExpressionAttributeValues = attr;
      }

      if (options.expressionAttributeNames)
      {
        data.ExpressionAttributeNames = options.expressionAttributeNames;
      }

      if (options.attributesToGet)
      {
        data.AttributesToGet = options.attributesToGet;
      }
      if (options.limit)
      {
        data.Limit = options.limit;
      }
      if(options.returnValues)
      {
        data.ReturnValues = options.returnValues;
      }
    }
    catch (err)
    {
      cb(err);
      return;
    }
    //console.log(require('util').inspect(data, false, 20));
    execute('UpdateItem', data, function(err, res)
    {
      if (err)
      {
        cb(err)
      }
      else
      {
        my.consumedCapacity += res.ConsumedCapacity.CapacityUnits;
        try
        {
          var attr = objFromDDB(res.Attributes);
        }
        catch (err)
        {
          cb(err);
          return;
        }
        cb(null, attr, res.ConsumedCapacity.CapacityUnits);
      }
    });
  };


  /**
   * An object representing a table query, or an array of such objects
   * { 'table': { keys: [1, 2, 3], attributesToGet: ['user', 'status'] } }
   *           or keys: [['id', 'range'], ['id2', 'range2']]
   * @param cb callback(err, tables) err is set if an error occured
   */
  batchGetItem = function(request, cb)
  {
    var data = {};
    try
    {
      data.RequestItems = {};
      for (var table in request)
      {
        if (request.hasOwnProperty(table))
        {
          var parts = Array.isArray(request[table]) ? request[table] : [request[table]];

          for (var i = 0; i < parts.length; ++i)
          {
            var part = parts[i];
            var tableData = {
              Keys: []
            };
            var hasRange = Array.isArray(part.keys[0]);

            for (var j = 0; j < part.keys.length; j++)
            {
              var key = part.keys[j];
              var keyData = objToDDB(key);
              tableData.Keys.push(keyData);
            }

            if (part.attributesToGet)
            {
              tableData.AttributesToGet = part.attributesToGet;
            }
            if (part.consistentRead)
            {
              tableData.ConsistentRead = part.consistentRead;
            }

            data.RequestItems[table] = tableData;
          }
        }
      }
    }
    catch (err)
    {
      cb(err);
      return;
    }
    execute('BatchGetItem', data, function(err, res)
    {
      if (err)
      {
        cb(err)
      }
      else
      {
        var consumedCapacity = 0;
        for (var table in res.Responses)
        {
          var part = res.Responses[table];
          var cap = part.ConsumedCapacity.CapacityUnits;
          if (cap)
          {
            consumedCapacity += cap;
          }
          if (part.Items)
          {
            try
            {
              part.items = arrFromDDB(part.Items);
            }
            catch (err)
            {
              cb(err);
              return;
            }
            delete part.Items;
          }
          if (res.UnprocessedKeys[table])
          {
            part.UnprocessedKeys = res.UnprocessedKeys[table];
          }
        }
        my.consumedCapacity += consumedCapacity;
        if (parts.length == 1)
        {
          var smartResponse = res.Responses[table];
          cb(null, smartResponse, consumedCapacity);
        }
        else
        {
          cb(null, res.Responses, consumedCapacity);
        }
      }
    });
  };

  /**
   * Put or delete several items across multiple tables
   * @param putRequest dictionnary { 'table': [item1, item2, item3], 'table2': item }
   * @param deleteRequest dictionnary { 'table': [key1, key2, key3], 'table2': [[id1, range1], [id2, range2]] }
   * @param cb callback(err, res, cap) err is set if an error occured
   */
  batchWriteItem = function(putRequest, deleteRequest, cb)
  {
    var data = {};
    try
    {
      data.RequestItems = {};

      for (var table in putRequest)
      {
        if (putRequest.hasOwnProperty(table))
        {
          var items = (Array.isArray(putRequest[table]) ? putRequest[table] : [putRequest[table]]);

          for (var i = 0; i < items.length; i++)
          {
            data.RequestItems[table] = data.RequestItems[table] || [];
            data.RequestItems[table].push(
            {
              "PutRequest":
              {
                "Item": objToDDB(items[i])
              }
            });
          }
        }
      }

      for (var table in deleteRequest)
      {
        if (deleteRequest.hasOwnProperty(table))
        {
          var items = (Array.isArray(deleteRequest[table]) ? deleteRequest[table] : [deleteRequest[table]]);

          for (var i = 0; i < items.length; i++)
          {
            data.RequestItems[table] = data.RequestItems[table] || [];
            data.RequestItems[table].push(
            {
              "DeleteRequest":
              {
                "Key": objToDDB(items[i])
              }
            });
          }
        }
      }
      execute('BatchWriteItem', data, function(err, res)
      {
        if (err)
          cb(err);
        else
        {
          var consumedCapacity = 0;
          for (var i = 0; i < res.ConsumedCapacity.length; i++)
          {
            consumedCapacity += res.ConsumedCapacity[i].CapacityUnits;
          }
          my.consumedCapacity += consumedCapacity;
          cb(null, res.UnprocessedItems, consumedCapacity);
        }
      });
    }
    catch (err)
    {
      cb(err)
    }
  };

  /**
   * returns a set of Attributes for an item that matches the query
   * @param table the tableName
   * @param keys the table {id:2,range:3} range is optional
   * @param the hash key + operator ex. {id: 'EQ'}
   * @param options {attributesToGet, limit, consistentRead, count,
   *                 rangeKeyCondition, scanIndexForward, exclusiveStartKey, indexName, filter}
   *
   * @param cb callback(err, tables) err is set if an error occured
   */
  query = function(table, keys, operators, options, cb)
  {
    var data = {};
    try
    {
      data.KeyConditions = {};
      for (var i in keys)
      {
        if (keys.hasOwnProperty(i))
        {
          data.KeyConditions[i] = {
            ComparisonOperator: operators[i],
            AttributeValueList: [scToDDB(keys[i])]
          }
        }
      }
      data.TableName = table;

      if(options.filter) {
          var filter = options.filter,
            queryFilter = {},
            operator,
            value;

          for(var attr in filter.keys) {
              operator = filter.operators[attr].toUpperCase(),
                value = filter.keys[attr];

              queryFilter[attr] = {
                 ComparisonOperator: operator,
                 AttributeValueList: []
             };

            if(filter.keys.hasOwnProperty(attr)) {
                if((operator === 'BETWEEN' || operator === 'IN') && Array.isArray(value) && value.length > 1){
                    for(var i = 0; i < value.length; i++){
                        queryFilter[attr].AttributeValueList.push(scToDDB(value[i]));
                    }
                } else {
                  queryFilter[attr].AttributeValueList.push(scToDDB(value));
                }
            }
        }
        data.QueryFilter = queryFilter;
      }

      if (options.filterExpression)
      {
        data.FilterExpression = options.filterExpression;
      }

      if (options.expressionAttributeValues)
      {
        var attr = {};
        for (var i in options.expressionAttributeValues)
        {
          if (options.expressionAttributeValues.hasOwnProperty(i))
          {
            attr[i] = scToDDB(options.expressionAttributeValues[i]);
          }
        }
        data.ExpressionAttributeValues = attr;
      }

      if (options.expressionAttributeNames)
      {
        data.ExpressionAttributeNames = options.expressionAttributeNames;
      }

      if (options.attributesToGet)
      {
        data.AttributesToGet = options.attributesToGet;
      }
      if (options.limit)
      {
        data.Limit = options.limit;
      }
      if (options.consistentRead)
      {
        data.ConsistentRead = options.consistentRead;
      }
      if (options.count && !options.attributesToGet)
      {
        data.Count = options.count;
      }

      if (options.scanIndexForward === false)
      {
        data.ScanIndexForward = false;
      }
      if (options.exclusiveStartKey)
      {
        data.ExclusiveStartKey = {};
        for (var i in options.exclusiveStartKey)
        {
          data.ExclusiveStartKey[i] = scToDDB(options.exclusiveStartKey[i]);
        }
      }
      if (options.indexName)
      {
        data.IndexName = options.indexName;
      }
    }
    catch (err)
    {
      cb(err);
      return;
    }
    execute('Query', data, function(err, res)
    {
      if (err)
      {
        cb(err)
      }
      else
      {
        my.consumedCapacity += res.ConsumedCapacity.CapacityUnits;
        var r = {
          count: res.Count,
          items: [],
          lastEvaluatedKey: null,
          scannedCount: res.ScannedCount
        };
        try
        {
          if (res.Items)
          {
            r.items = arrFromDDB(res.Items);
          }
          if (res.LastEvaluatedKey)
          {
            var key = objFromDDB(res.LastEvaluatedKey);
            r.lastEvaluatedKey = key;
          }
        }
        catch (err)
        {
          cb(err);
          return;
        }
        cb(null, r, res.ConsumedCapacity.CapacityUnits);
      }
    });
  };


  /**
   * returns one or more items and its attributes by performing a full scan of a table.
   * @param table the tableName
   * @param options {attributesToGet, limit, count, scanFilter, exclusiveStartKey}
   * @param cb callback(err, {count, items, lastEvaluatedKey}) err is set if an error occured
   */
  scan = function(table, options, cb)
  {
    var data = {};
    try
    {
      data.TableName = table;
      if (options.attributesToGet)
      {
        data.AttributesToGet = options.attributesToGet;
      }


      if (options.filterExpression)
      {
        data.FilterExpression = options.filterExpression;
      }

      if (options.expressionAttributeValues)
      {
        var attr = {};
        for (var i in options.expressionAttributeValues)
        {
          if (options.expressionAttributeValues.hasOwnProperty(i))
          {
            attr[i] = scToDDB(options.expressionAttributeValues[i]);
          }
        }
        data.ExpressionAttributeValues = attr;
      }

      if (options.expressionAttributeNames)
      {
        data.ExpressionAttributeNames = options.expressionAttributeNames;
      }

      if (options.limit)
      {
        data.Limit = options.limit;
      }
      if (options.count && !options.attributesToGet)
      {
        data.Count = options.count;
      }
      if (options.exclusiveStartKey)
      {
        data.ExclusiveStartKey = {};
        for (var i in options.exclusiveStartKey)
        {
          data.ExclusiveStartKey[i] = scToDDB(options.exclusiveStartKey[i]);
        }
      }
      if (options.filter)
      {
        data.ScanFilter = {}
        for (var attr in options.filter)
        {
          if (options.filter.hasOwnProperty(attr))
          {
            for (var op in options.filter[attr])
            { // supposed to be only one
              if (typeof op === 'string')
              {
                data.ScanFilter[attr] = {
                  "AttributeValueList": [],
                  "ComparisonOperator": op.toUpperCase()
                };
                if (op === 'not_null' || op === 'null')
                {
                  // nothing ot do
                }
                else if ((op == 'between' || op == 'in') &&
                  Array.isArray(options.filter[attr][op]) &&
                  options.filter[attr][op].length > 1)
                {
                  for (var i = 0; i < options.filter[attr][op].length; ++i)
                  {
                    data.ScanFilter[attr].AttributeValueList.push(scToDDB(options.filter[attr][op][i]));
                  }
                }
                else
                {
                  data.ScanFilter[attr].AttributeValueList.push(scToDDB(options.filter[attr][op]));
                }
              }
            }
          }
        }
      }
    }
    catch (err)
    {
      cb(err);
      return;
    }
    //console.log(require('util').inspect(data));
    execute('Scan', data, function(err, res)
    {
      if (err)
      {
        cb(err)
      }
      else
      {
        my.consumedCapacity += res.ConsumedCapacity.CapacityUnits;
        var r = {
          count: res.Count,
          items: [],
          lastEvaluatedKey: null,
          scannedCount: res.ScannedCount
        };
        try
        {
          if (Array.isArray(res.Items))
          {
            r.items = arrFromDDB(res.Items);
          }
          if (res.LastEvaluatedKey)
          {
            var key = objFromDDB(res.LastEvaluatedKey);
            r.lastEvaluatedKey = key;
          }
        }
        catch (err)
        {
          cb(err);
          return;
        }
        cb(null, r, res.ConsumedCapacity.CapacityUnits);
      }
    });
  };



  //-- INTERNALS --//

  /**
   * converts a JSON object (dictionary of values) to an amazon DynamoDB
   * compatible JSON object
   * @param json the JSON object
   * @throws an error if input object is not compatible
   * @return res the converted object
   */
  objToDDB = function(json)
  {
    if (typeof json === 'object')
    {
      var res = {};
      for (var i in json)
      {
        if (json.hasOwnProperty(i))
        {
          res[i] = scToDDB(json[i]);
        }
      }
      return res;
    }
    else
      return json;
  };


  /**
   * converts a string, string array, number, number array (scalar), map or map array
   * JSON object to an amazon DynamoDB compatible JSON object
   * @param json the JSON scalar object
   * @throws an error if input object is not compatible
   * @return res the converted object
   */
  scToDDB = function(value)
  {
    if (typeof value === 'number')
    {
      return {
        "N": value.toString()
      };
    }
    if (typeof value === 'string')
    {
      return {
        "S": value
      };
    }
    if (typeof value === 'boolean')
    {
      return {
        "BOOL": value
      };
    }
    if (value === null)
    {
      return {
        "NULL": true
      };
    }
    if (!Array.isArray(value) && typeof value === 'object' && value !== null)
    {
      return {
        "M": mapToDDB(value)
      };
    }

    if (Array.isArray(value))
    {
      var arr = [];
      var length = value.length;
      var isSS = "NS";
      for (var i = 0; i < length; ++i)
      {
        if (typeof value[i] === 'string')
        {
          arr[i] = value[i];
          isSS = "SS";
        }
        else if (typeof value[i] === 'number')
        {
          arr[i] = value[i].toString();
        }
        else if (typeof value[i] === 'object')
        {
          arr[i] = {
            "M": mapToDDB(value[i])
          };
          isSS = "L";
        }
      }

      switch (isSS)
      {
        case "NS":
          return {
            "NS": arr
          };
          break;
        case "SS":
          return {
            "SS": arr
          };
          break;
        case "L":
          return {
            "L": arr
          };
          break;
        case "M":
          return {
            "M": arr
          };
          break;
      }
    }
    throw new Error('Non Compatible Field [not string|number|string array|number array]: ' + value);
  }

  /**
   * converts any javascript object to a map object. Handles 1 level
   * a native JSON object
   * @param the object
   * @return res the converted object
   */

  mapToDDB = function(obj)
  {
    var nObj = {};
    for (key in obj)
    {
      if (obj.hasOwnProperty(key))
      {
        nObj[key] = scToDDB(obj[key]);
      }
    }

    return nObj;
  }

  /**
   * converts any javascript object to a map object. Handles 1 level
   * a native JSON object
   * @param the object
   * @return res the converted object
   */

  mapFromDDB = function(obj)
  {
    var nObj = {};
    for (key in obj)
    {
      if (obj.hasOwnProperty(key))
      {
        nObj[key] = objFromDDB(obj[key]);
      }
    }

    return nObj;
  }


  /**
   * converts a DynamoDB compatible JSON object into
   * a native JSON object
   * @param ddb the ddb JSON object
   * @throws an error if input object is not compatible
   * @return res the converted object
   */
  objFromDDB = function(ddb)
  {
    if (typeof ddb === 'object')
    {
      var res = {};
      for (var i in ddb)
      {
        if (ddb.hasOwnProperty(i))
        {
          if (ddb[i]['S'])
            res[i] = ddb[i]['S'];
          else if (ddb[i]['SS'])
            res[i] = ddb[i]['SS'];
          else if (ddb[i]['N'])
            res[i] = parseFloat(ddb[i]['N']);
          else if (ddb[i]['NS'])
          {
            res[i] = [];
            for (var j = 0; j < ddb[i]['NS'].length; j++)
            {
              res[i][j] = parseFloat(ddb[i]['NS'][j]);
            }
          }
          else if (ddb[i]['BOOL'] !== undefined)
          {
            res[i] = ddb[i]['BOOL'];
          }
          else if (ddb[i]['NULL'])
          {
            res[i] = null;
          }
          else if (ddb[i]['M'])
          {
            res[i] = objFromDDB(ddb[i]['M']);
          }
          else if (ddb[i]['L'])
          {
            res[i] = objFromDDB(ddb[i]['L']);
          }
          else
            throw new Error('Non Compatible Field [not "S"|"N"|"NS"|"SS"]: ' + i);
        }
      }
      return res;
    }
    else
      return ddb;
  };


  /**
   * converts an array of DynamoDB compatible JSON object into
   * an array of native JSON object
   * @param arr the array of ddb  objects to convert
   * @throws an error if input object is not compatible
   * @return res the converted object
   */
  arrFromDDB = function(arr)
  {
    var length = arr.length;
    for (var i = 0; i < length; ++i)
    {
      arr[i] = objFromDDB(arr[i]);
    }
    return arr;
  };


  /**
   * executes a constructed request, eventually calling auth.
   * @param request JSON request body
   * @param cb callback(err, result) err specified in case of error
   */

  execute = function(op, data, cb)
  {

    var date = new Date();

    var headers = {
      "host": my.endpoint,
      "x-amz-date": Signer._requestDate(date),
      "x-amz-target": "DynamoDB_20120810." + op,
      "content-type": "application/x-amz-json-1.0"
    };
    data.ReturnConsumedCapacity = 'TOTAL';
    var request = {
      method: "POST",
      uri: "/",
      query: "",
      headers: headers,
      body: JSON.stringify(data)
    };

    headers.authorization = Signer.authorization(spec.credentials, request, date, spec.region);

    if ('securityToken' in spec.credentials)
      headers["x-amz-security-token"] = self.credentials.securityToken;

    var opts = {
      method: request.method,
      path: request.uri,
      headers: headers,
      host: my.endpoint
    };


    var executeRequest = function(cb)
    {
      var reqCb = function(res)
      {
        var body = '';
        res.on('data', function(chunk)
        {
          body += chunk;
        });
        res.on('end', function()
        {
          if (!cb)
          {
            // Do not call callback if it's already been called in the error handler.
            return;
          }
          try
          {
            var json = JSON.parse(body);
          }
          catch (err)
          {
            cb(err);
            return;
          }
          if (res.statusCode >= 300)
          {
            var err = new Error(op + ' [' + res.statusCode + ']: ' + (json.message || json['__type']));
            err.type = json['__type'];
            err.statusCode = res.statusCode;
            err.requestId = res.headers['x-amzn-requestid'];
            err.message = op + ' [' + res.statusCode + ']: ' + (json.message || json['__type']);
            err.code = err.type.substring(err.type.lastIndexOf("#") + 1, err.type.length);
            err.data = json;
            cb(err);
          }
          else
          {
            cb(null, json);
          }
        });
      };

      if(!spec.https)
        var req = http.request(opts, reqCb);
      else
        var req = https.request(opts, reqCb);


      req.setTimeout(0);

      req.on('error', function(err)
      {
        cb(err);
        cb = undefined; // Clear callback so we do not call it twice
      });

      req.write(request.body);
      req.end();
    };

    // see: https://github.com/amazonwebservices/aws-sdk-for-php/blob/master/sdk.class.php
    // for the original php retry logic used here
    (function retry(c)
    {
      executeRequest(function(err, json)
      {
        if (err != null)
        {
          if (err.statusCode === 500 || err.statusCode === 503)
          {
            if (c <= my.retries)
            {
              setTimeout(function()
              {
                retry(c + 1);
              }, Math.pow(4, c) * 100);
            }
            else
              cb(err);
          }
          else if (err.statusCode === 400 &&
            (err.code === "ProvisionedThroughputExceededException"))
          {
            if (c === 0)
            {
              retry(c + 1);
            }
            else if (c <= my.retries && c <= 10)
            {
              setTimeout(function()
              {
                retry(c + 1);
              }, Math.pow(2, c - 1) * (25 * (Math.random() + 1)));
            }
            else
              cb(err);
          }
          else
          {
            cb(err);
          }
        }
        else
        {
          cb(null, json);
        }
      });
    })(0);

  };

  fwk.method(that, 'createTable', createTable, _super);
  fwk.method(that, 'listTables', listTables, _super);
  fwk.method(that, 'describeTable', describeTable, _super);
  fwk.method(that, 'updateTable', updateTable, _super);
  fwk.method(that, 'deleteTable', deleteTable, _super);

  fwk.method(that, 'putItem', putItem, _super);
  fwk.method(that, 'getItem', getItem, _super);
  fwk.method(that, 'deleteItem', deleteItem, _super);
  fwk.method(that, 'updateItem', updateItem, _super);
  fwk.method(that, 'query', query, _super);
  fwk.method(that, 'batchGetItem', batchGetItem, _super);
  fwk.method(that, 'batchWriteItem', batchWriteItem, _super);
  fwk.method(that, 'scan', scan, _super);


  // for testing purpose
  fwk.method(that, 'objToDDB', objToDDB, _super);
  fwk.method(that, 'scToDDB', scToDDB, _super);
  fwk.method(that, 'objFromDDB', objFromDDB, _super);
  fwk.method(that, 'arrFromDDB', arrFromDDB, _super);


  fwk.getter(that, 'consumedCapacity', my, 'consumedCapacity');
  fwk.getter(that, 'schemaTypes', my, 'schemaTypes');

  return that;
};


exports.ddb = ddb;
