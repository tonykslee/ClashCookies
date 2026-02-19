# LabelsApi

All URIs are relative to *https://api.clashofclans.com/v1*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**getClanLabels**](#getclanlabels) | **GET** /labels/clans | List clan labels|
|[**getPlayerLabels**](#getplayerlabels) | **GET** /labels/players | List player labels|

# **getClanLabels**
> LabelsObject getClanLabels()

List clan labels

### Example

```typescript
import {
    LabelsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new LabelsApi(configuration);

let limit: number; //Limit the number of items returned in the response. (optional) (default to undefined)
let after: string; //Return only items that occur after this marker. Before marker can be found from the response, inside the \'paging\' property. Note that only after or before can be specified for a request, not both.  (optional) (default to undefined)
let before: string; //Return only items that occur before this marker. Before marker can be found from the response, inside the \'paging\' property. Note that only after or before can be specified for a request, not both.  (optional) (default to undefined)

const { status, data } = await apiInstance.getClanLabels(
    limit,
    after,
    before
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **limit** | [**number**] | Limit the number of items returned in the response. | (optional) defaults to undefined|
| **after** | [**string**] | Return only items that occur after this marker. Before marker can be found from the response, inside the \&#39;paging\&#39; property. Note that only after or before can be specified for a request, not both.  | (optional) defaults to undefined|
| **before** | [**string**] | Return only items that occur before this marker. Before marker can be found from the response, inside the \&#39;paging\&#39; property. Note that only after or before can be specified for a request, not both.  | (optional) defaults to undefined|


### Return type

**LabelsObject**

### Authorization

[JWT](../README.md#JWT)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Successful response |  -  |
|**400** | Client provided incorrect parameters for the request. |  -  |
|**403** | Access denied, either because of missing/incorrect credentials or used API token does not grant access to the requested resource.  |  -  |
|**404** | Resource was not found. |  -  |
|**429** | Request was throttled, because amount of requests was above the threshold defined for the used API token.  |  -  |
|**500** | Unknown error happened when handling the request. |  -  |
|**503** | Service is temprorarily unavailable because of maintenance. |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getPlayerLabels**
> LabelsObject getPlayerLabels()

List player labels

### Example

```typescript
import {
    LabelsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new LabelsApi(configuration);

let limit: number; //Limit the number of items returned in the response. (optional) (default to undefined)
let after: string; //Return only items that occur after this marker. Before marker can be found from the response, inside the \'paging\' property. Note that only after or before can be specified for a request, not both.  (optional) (default to undefined)
let before: string; //Return only items that occur before this marker. Before marker can be found from the response, inside the \'paging\' property. Note that only after or before can be specified for a request, not both.  (optional) (default to undefined)

const { status, data } = await apiInstance.getPlayerLabels(
    limit,
    after,
    before
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **limit** | [**number**] | Limit the number of items returned in the response. | (optional) defaults to undefined|
| **after** | [**string**] | Return only items that occur after this marker. Before marker can be found from the response, inside the \&#39;paging\&#39; property. Note that only after or before can be specified for a request, not both.  | (optional) defaults to undefined|
| **before** | [**string**] | Return only items that occur before this marker. Before marker can be found from the response, inside the \&#39;paging\&#39; property. Note that only after or before can be specified for a request, not both.  | (optional) defaults to undefined|


### Return type

**LabelsObject**

### Authorization

[JWT](../README.md#JWT)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Successful response |  -  |
|**400** | Client provided incorrect parameters for the request. |  -  |
|**403** | Access denied, either because of missing/incorrect credentials or used API token does not grant access to the requested resource.  |  -  |
|**404** | Resource was not found. |  -  |
|**429** | Request was throttled, because amount of requests was above the threshold defined for the used API token.  |  -  |
|**500** | Unknown error happened when handling the request. |  -  |
|**503** | Service is temprorarily unavailable because of maintenance. |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

