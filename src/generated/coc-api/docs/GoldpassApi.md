# GoldpassApi

All URIs are relative to *https://api.clashofclans.com/v1*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**getCurrentGoldPassSeason**](#getcurrentgoldpassseason) | **GET** /goldpass/seasons/current | Get information about the current gold pass season.|

# **getCurrentGoldPassSeason**
> GoldPassSeason getCurrentGoldPassSeason()

Get information about the current gold pass season.

### Example

```typescript
import {
    GoldpassApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new GoldpassApi(configuration);

const { status, data } = await apiInstance.getCurrentGoldPassSeason();
```

### Parameters
This endpoint does not have any parameters.


### Return type

**GoldPassSeason**

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

